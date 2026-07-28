# Preset-Owned System Context Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make AGENTS.md, repository listings, and configured individual files preset-owned startup context that appears only in the system prompt on every SiftKit surface.

**Architecture:** A reusable `PresetSystemContextBuilder` loads and labels enabled sources once per run. Execution boundaries explicitly resolve their active preset, prompt builders consume the resulting context, and nonfatal file-load warnings flow through existing CLI/web streams.

**Tech Stack:** TypeScript 5.9, Zod, Node.js filesystem/path APIs, React, SQLite through `better-sqlite3`, Node test runner.

## Global Constraints

- Use TDD exclusively; prefer CLI, HTTP route, model-request, and rendered-component tests.
- Keep new code fully typed from Zod schemas at IO boundaries.
- Do not use `any`, type-assertion casts, non-null assertions, namespace imports, or unknown-laundering.
- Do not retain removed global config aliases or per-run Chat overrides in the completed implementation.
- Accept individual files only: no directories, globs, or recursive configured-file expansion.
- Resolve relative configured files from the run repository root; permit absolute PC paths.
- Skip missing, unreadable, empty, and non-file entries with visible warnings.
- Put every successfully loaded source only in the system message.
- Keep test artifacts below one suite-owned `.tmp/preset-system-context` directory and delete it during teardown.
- Do not use a git worktree.

---

## File Structure

### Create

- `src/preset-system-context.ts` — source loading, path resolution, formatting, and warning generation.
- `tests/preset-system-context.test.ts` — deterministic filesystem behavior and all loader branches.

### Delete

- `dashboard/src/hooks/useRepoSearchAutoAppend.ts`
- `dashboard/src/lib/repo-append-controls.ts`
- `dashboard/tests/hooks/useRepoSearchAutoAppend.test.tsx`

### Modify

- Preset/config contracts: `packages/contracts/src/config.ts`, `src/presets.ts`, `src/config/*`
- Prompt/runtime paths: `src/repo-search/*`, `src/summary/*`, `src/command-output/*`
- Server boundaries: `src/status-server/preset-runner.ts`, `src/status-server/routes/core.ts`, `src/status-server/routes/chat.ts`, `src/status-server/chat-prompt-context.ts`
- Warning transport: `src/cli/progress-renderer.ts`, `src/status-server/operation-progress-writers.ts`, `src/status-server/dashboard-runs.ts`, `dashboard/src/lib/chat-stream-parser.ts`
- Dashboard settings/chat: `dashboard/src/tabs/settings/PresetsSection.tsx`, `dashboard/src/hooks/useSettingsController.ts`, `dashboard/src/tabs/SettingsTab.tsx`, `dashboard/src/hooks/useChatComposer.ts`, `dashboard/src/hooks/useChatController.ts`, `dashboard/src/tabs/ChatTab.tsx`
- Persistence: `src/status-server/config-store.ts`, `src/state/runtime-db.ts`
- Focused tests and typed fixtures listed in each task

---

### Task 1: Add the per-preset file-list contract

**Files:**

- Modify: `packages/contracts/src/config.ts:143`
- Modify: `src/presets.ts:29`
- Modify: `dashboard/src/hooks/useSettingsController.ts:182`
- Test: `tests/presets.test.ts`
- Test: `tests/config-normalization.test.ts`
- Test: `dashboard/tests/fixtures.ts`
- Test: `dashboard/tests/chat-tab.test.tsx`
- Test: `tests/helpers/runtime-config.ts`

**Interfaces:**

- Produces: `SiftPreset.autoloadFiles: string[]`
- Produces: trimmed, deduplicated, first-seen-order configured paths
- Leaves the two global config fields temporarily untouched until Task 5, after all consumers have moved

- [ ] **Step 1: Write failing preset tests**

```ts
test('preset normalization trims and deduplicates autoload files', () => {
  const presets = normalizePresets([{
    id: 'summary',
    autoloadFiles: [' docs/policy.md ', 'C:\\shared\\rules.md', '', 'docs/policy.md'],
  }]);
  const summary = presets.find((preset) => preset.id === 'summary');
  assert.deepEqual(summary?.autoloadFiles, ['docs/policy.md', 'C:\\shared\\rules.md']);
});

test('built-in presets default to no configured files', () => {
  assert.deepEqual(normalizePresets([]).map((preset) => preset.autoloadFiles), [[], [], [], [], []]);
});
```

Add `autoloadFiles: []` to every typed preset fixture touched by typecheck.

- [ ] **Step 2: Run focused tests and verify RED**

```powershell
npm test -- presets config-normalization dashboard-presets chat-tab
```

Expected: typecheck/assertions fail because `autoloadFiles` does not exist.

- [ ] **Step 3: Implement schema and normalization**

Add the field to the contract:

```ts
autoloadFiles: z.array(z.string()),
```

Add one normalizer:

```ts
function normalizeAutoloadFiles(value: OptionalJsonValue): string[] {
  if (!Array.isArray(value)) return [];
  const files: string[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string') continue;
    const file = entry.trim();
    if (file && !files.includes(file)) files.push(file);
  }
  return files;
}
```

Thread `autoloadFiles` through `SiftPreset`, `buildPreset`, all built-ins, built-in overlays, custom preset normalization, and new-dashboard-preset creation. Default it to `[]`.

- [ ] **Step 4: Run focused tests and verify GREEN**

```powershell
npm test -- presets config-normalization dashboard-presets chat-tab
```

Expected: selected tests pass.

- [ ] **Step 5: Commit**

```powershell
git add packages/contracts/src/config.ts src/presets.ts dashboard/src/hooks/useSettingsController.ts tests/presets.test.ts tests/config-normalization.test.ts dashboard/tests/fixtures.ts dashboard/tests/chat-tab.test.tsx tests/helpers/runtime-config.ts
git commit -m "feat: add preset autoload files"
```

---

### Task 2: Build the reusable preset context loader

**Files:**

- Create: `src/preset-system-context.ts`
- Create: `tests/preset-system-context.test.ts`
- Modify: `src/repo-search/prompts.ts:186`

**Interfaces:**

```ts
export type PresetSystemContext = {
  content: string;
  warnings: string[];
  hasAgentsMd: boolean;
  hasRepoFileListing: boolean;
  loadedFiles: string[];
};

export class PresetSystemContextBuilder {
  constructor(repoRoot: string);
  build(preset: Pick<SiftPreset, 'includeAgentsMd' | 'includeRepoFileListing' | 'autoloadFiles'>): PresetSystemContext;
}
```

- [ ] **Step 1: Write failing builder and placement tests**

Create all fixtures under `tests/.tmp/preset-system-context`:

```ts
test('builder loads enabled sources in stable order', () => {
  const context = new PresetSystemContextBuilder(repoRoot).build({
    includeAgentsMd: true,
    includeRepoFileListing: true,
    autoloadFiles: ['docs/local.md', absolutePolicyPath],
  });

  const agentsIndex = context.content.indexOf('--- AGENTS.md (project-specific instructions) ---');
  const listingIndex = context.content.indexOf('--- Repository file listing (respects ignore policy) ---');
  const localIndex = context.content.indexOf('--- Autoloaded file: docs/local.md ---');
  const absoluteIndex = context.content.indexOf(`--- Autoloaded file: ${absolutePolicyPath} ---`);
  assert.equal(agentsIndex >= 0, true);
  assert.equal(agentsIndex < listingIndex && listingIndex < localIndex && localIndex < absoluteIndex, true);
  assert.deepEqual(context.loadedFiles, ['docs/local.md', absolutePolicyPath]);
  assert.deepEqual(context.warnings, []);
});

test('builder skips each invalid configured file with a specific warning', () => {
  const context = new PresetSystemContextBuilder(repoRoot).build({
    includeAgentsMd: false,
    includeRepoFileListing: false,
    autoloadFiles: ['missing.md', 'empty.md', 'directory'],
  });

  assert.equal(context.content, '');
  assert.deepEqual(context.loadedFiles, []);
  assert.equal(context.warnings.length, 3);
  assert.match(context.warnings.join('\n'), /missing\.md.*does not exist/u);
  assert.match(context.warnings.join('\n'), /empty\.md.*empty/u);
  assert.match(context.warnings.join('\n'), /directory.*not a file/u);
});

```

- [ ] **Step 2: Run focused tests and verify RED**

```powershell
npm test -- preset-system-context
```

Expected: builder import fails.

- [ ] **Step 3: Implement the builder**

Use named imports from `node:fs` and `node:path`. Resolve each configured path with:

```ts
const resolvedPath = isAbsolute(configuredPath)
  ? normalize(configuredPath)
  : resolve(this.repoRoot, configuredPath);
```

Use `statSync` to reject non-files and `readFileSync(resolvedPath, 'utf8').trim()` to reject empty files. Use existing `readAgentsMd`, `scanRepoFiles`, and `buildIgnorePolicy` for built-in sources. Catch configured-file failures independently and emit:

```ts
`Autoload file '${configuredPath}' skipped: ${reason}.`
```

Add a read-error test branch using a Windows-invalid file path; on non-Windows, use a fixture with read permission removed and restore permission in teardown.

- [ ] **Step 4: Run focused tests and verify GREEN**

```powershell
npm test -- preset-system-context
```

Expected: all builder branches pass.

- [ ] **Step 5: Commit**

```powershell
git add src/preset-system-context.ts src/repo-search/prompts.ts tests/preset-system-context.test.ts
git commit -m "feat: build preset system context"
```

---

### Task 3: Resolve presets on every execution surface and emit warnings

**Files:**

- Modify: `src/summary/types.ts:54`
- Modify: `src/summary/request-runner.ts:67`
- Modify: `src/summary/progress-reporter.ts:1`
- Modify: `src/command-output/types.ts:12`
- Modify: `src/command-output/analyzer.ts:170`
- Modify: `src/repo-search/prompts.ts:211`
- Modify: `src/repo-search/engine/task-loop.ts:204`
- Modify: `src/repo-search/engine/task-loop-support.ts:161`
- Modify: `src/repo-search/engine.ts:155`
- Modify: `src/repo-search/execute.ts:314`
- Modify: `src/repo-search/types.ts:48`
- Modify: `src/status-server/preset-runner.ts:137`
- Modify: `src/status-server/routes/core.ts:716`
- Modify: `src/status-server/routes/chat.ts:1157`
- Modify: `src/status-server/chat-prompt-context.ts:50`
- Modify: `src/status-server/operation-progress-writers.ts:22`
- Modify: `src/status-server/dashboard-runs.ts:175`
- Modify: `src/cli/run-summary.ts:8`
- Modify: `src/cli/run-repo-search.ts:21`
- Modify: `src/cli/run-preset.ts:8`
- Modify: `src/cli/progress-renderer.ts:10`
- Test: `tests/cli-http-boundary.test.ts`
- Test: `tests/cli-progress-renderer.test.ts`
- Test: `tests/summary-status-server.test.ts`
- Test: `tests/repo-search-prompts.test.ts`
- Test: `tests/repo-search-loop.core.test.ts`
- Test: `tests/repo-search-agent-execute.test.ts`
- Test: `tests/repo-search-status-server.test.ts`
- Test: `tests/dashboard-status-server.test.ts`
- Test: `tests/streamed-op-endpoints.test.ts`

**Interfaces:**

- `SummaryRequest` gains required `repoRoot: string` and optional `presetId: string`.
- `RepoSearchExecutionRequest` gains required `presetId: string`.
- Summary and repo progress events gain `context_warning` plus `warningText?: string`.
- Repo prompt/loop APIs consume required `PresetSystemContext`.

- [ ] **Step 1: Write failing boundary tests**

Extend `tests/cli-http-boundary.test.ts`:

```ts
assert.equal(summaryRequest.body.repoRoot, process.cwd());
assert.equal(commandRequest.body.repoRoot, process.cwd());
assert.equal(repoRequest.body.repoRoot, process.cwd());
```

Use the existing fake model-request capture pattern in summary/repo/dashboard status tests:

```ts
const captured = asObject(parseJsonValueText(capturedChatRawBody));
const messages = asObjectArray(captured.messages);
const systemText = messages
  .filter((message) => message.role === 'system')
  .map((message) => String(message.content ?? ''))
  .join('\n');
const userText = messages
  .filter((message) => message.role === 'user')
  .map((message) => String(message.content ?? ''))
  .join('\n');
assert.match(systemText, /Autoloaded file: docs\/route-policy\.md/u);
assert.doesNotMatch(userText, /Autoloaded file|route policy text/u);
```

Cover default summary (`useForSummary`), direct `repo-search`, direct `repo-agent`, explicit `/preset/run`, and the selected web Chat preset.

Add direct prompt placement coverage:

```ts
test('autoload content is absent from the initial user message', () => {
  const context = {
    content: '--- Autoloaded file: docs/policy.md ---\n\npolicy text',
    warnings: [],
    hasAgentsMd: false,
    hasRepoFileListing: false,
    loadedFiles: ['docs/policy.md'],
  } satisfies PresetSystemContext;
  const system = buildTaskSystemPrompt(context);
  const user = buildTaskInitialUserPrompt('locate policy use');
  assert.match(system, /Autoloaded file: docs\/policy\.md/u);
  assert.doesNotMatch(user, /Autoloaded file|policy text/u);
  assert.equal(user, 'Task: locate policy use');
});
```

- [ ] **Step 2: Write failing warning transport tests**

```ts
test('warning-only renderer prints context warnings without --progress', () => {
  const stderr = makeCaptureStream();
  const renderer = CliProgressRenderer.forCli(stderr.stream, 'summary', false);
  renderer.render({
    kind: 'context_warning',
    warningText: "Autoload file 'missing.md' skipped: does not exist.",
  });
  assert.match(stderr.read(), /missing\.md.*does not exist/u);
});
```

Add server-log and SSE assertions for `context_warning`.

- [ ] **Step 3: Run focused tests and verify RED**

```powershell
npm test -- cli-http-boundary cli-progress-renderer summary-status-server repo-search-prompts repo-search-loop.core repo-search-agent-execute repo-search-status-server dashboard-status-server streamed-op-endpoints
```

Expected: repo roots/preset IDs are missing, loaded content remains in the initial user message, direct routes bypass presets, and silent renderers suppress warnings.

- [ ] **Step 4: Refactor repo prompt and loop APIs**

Use:

```ts
export function buildTaskSystemPrompt(context: PresetSystemContext): string;
export function buildAgentSystemPrompt(context: PresetSystemContext): string;
export function buildTaskInitialUserPrompt(question: string): string {
  return `Task: ${question}`;
}
```

Replace loop booleans and bootstrap scanning with required `systemContext: PresetSystemContext`. Use `systemContext.hasRepoFileListing` for planner guidance and append `systemContext.content` after execution-family instructions.

- [ ] **Step 5: Wire summary and command-output execution**

After config load:

```ts
const presets = normalizePresets(config.Presets);
const preset = this.request.presetId
  ? findPresetById(presets, this.request.presetId)
  : resolveSummaryPreset(presets);
if (!preset) throw new Error(`Summary preset '${this.request.presetId}' was not found.`);
const context = new PresetSystemContextBuilder(this.request.repoRoot).build(preset);
```

Compose system-prefix sections in this order: preset prompt prefix, explicit request prefix, loaded context. Emit every warning through `SummaryProgressReporter.contextWarning`.

Make summary and command-output CLI requests send `process.cwd()`. `StatusPresetRunner.runSummaryPreset` sends its explicit preset ID.

- [ ] **Step 6: Wire repo, preset, and Chat execution**

Direct routes choose:

```ts
const presetId = this.mode === 'agent' ? 'repo-agent' : 'repo-search';
```

`executeRepoSearchRequest` resolves `request.presetId`, builds context once, writes `context_warning` events, and passes `systemContext` through `runRepoSearch`. Plan/search/direct-chat routes pass the session preset ID. `StatusPresetRunner` passes its explicit preset ID. `buildChatPromptContext` uses the same builder so displayed and submitted system prompts match.

Delete all `resolveEffectiveAgentsMd` and `resolveEffectiveRepoFileListing` helpers; no execution path may read the global fields after this step.

- [ ] **Step 7: Make warnings visible without normal progress**

Format:

```ts
if (kind === 'context_warning') {
  return `warning: ${reader.optionalString('warningText') || 'startup context was skipped'}`;
}
```

Replace `SilentProgressRenderer` with a warning-only renderer that delegates only `context_warning`. Log warning events with severity `warning`. Forward Chat warnings as:

```ts
writer.writeEvent('warning', { warning: event.warningText ?? '' });
```

- [ ] **Step 8: Run focused tests and verify GREEN**

```powershell
npm test -- cli-http-boundary cli-progress-renderer summary-status-server repo-search-prompts repo-search-loop.core repo-search-agent-execute repo-search-status-server dashboard-status-server streamed-op-endpoints
```

Expected: all command families use their preset and skipped-file warnings reach CLI/SSE/log boundaries.

- [ ] **Step 9: Commit**

```powershell
git add src/summary src/command-output src/repo-search src/status-server src/cli tests/cli-http-boundary.test.ts tests/cli-progress-renderer.test.ts tests/summary-status-server.test.ts tests/repo-search-prompts.test.ts tests/repo-search-loop.core.test.ts tests/repo-search-agent-execute.test.ts tests/repo-search-status-server.test.ts tests/dashboard-status-server.test.ts tests/streamed-op-endpoints.test.ts
git commit -m "feat: apply preset context across execution surfaces"
```

---

### Task 4: Replace dashboard controls and delete Chat overrides

**Files:**

- Modify: `dashboard/src/tabs/settings/PresetsSection.tsx:155`
- Modify: `dashboard/src/hooks/useSettingsController.ts:182`
- Modify: `dashboard/src/tabs/SettingsTab.tsx:142`
- Modify: `dashboard/src/settings-sections.ts:38`
- Modify: `dashboard/src/api.ts:336`
- Modify: `dashboard/src/hooks/useChatComposer.ts:1`
- Modify: `dashboard/src/hooks/useChatController.ts:1`
- Modify: `dashboard/src/tabs/ChatTab.tsx:90`
- Modify: `dashboard/src/lib/chat-stream-parser.ts:7`
- Modify: `dashboard/src/lib/chatMessages.ts:60`
- Modify: `dashboard/src/types.ts:29`
- Modify: `packages/contracts/src/chat.ts:55`
- Delete: `dashboard/src/hooks/useRepoSearchAutoAppend.ts`
- Delete: `dashboard/src/lib/repo-append-controls.ts`
- Delete: `dashboard/tests/hooks/useRepoSearchAutoAppend.test.tsx`
- Test: `dashboard/tests/presets-section.test.tsx`
- Test: `dashboard/tests/settings-tab.test.tsx`
- Test: `dashboard/tests/chat-tab.test.tsx`
- Test: `dashboard/tests/hooks/useChatComposer.test.tsx`
- Test: `dashboard/tests/chat-stream-parser.test.ts`
- Test: `dashboard/tests/lib/chatMessages.test.ts`

**Interfaces:**

- Preset editor mutates `autoloadFiles` by explicit Add, input edit, and Remove controls.
- Deletes `RepoSearchAutoAppendPreview` and `RepoSearchAutoAppendSelection`.
- Adds `ChatStreamEvent` variant `{ kind: 'warning'; text: string }`.
- Adds `UseChatComposerResult.warnings: string[]`.

- [ ] **Step 1: Write failing rendered-component tests**

```ts
test('preset editor shows startup context for summary presets', () => {
  const preset = {
    ...CUSTOM_PRESET,
    operationMode: 'summary',
    autoloadFiles: ['C:\\shared\\rules.md'],
  } satisfies DashboardPreset;
  const markup = renderToStaticMarkup(
    <PresetsSection
      dashboardConfig={{ ...DASHBOARD_CONFIG, Presets: [preset] }}
      selectedSettingsPreset={preset}
      selectedSettingsPresetId={preset.id}
      setSelectedSettingsPresetId={() => {}}
      updateSettingsDraft={() => {}}
      updatePresetDraft={() => {}}
      onAddPreset={() => {}}
      onDeletePreset={() => {}}
    />,
  );
  assert.match(markup, /Load AGENTS\.md/u);
  assert.match(markup, /Load repository file list/u);
  assert.match(markup, /Autoload files/u);
  assert.match(markup, /C:\\shared\\rules\.md/u);
  assert.match(markup, /\+ Add file/u);
  assert.match(markup, /Remove/u);
});

test('chat does not render first-message context toggles', () => {
  assert.doesNotMatch(render({ chatMode: 'repo-search' }), /Repo-search auto-append controls|File scan/u);
});
```

Add Settings assertions that the two global controls are absent.

- [ ] **Step 2: Write failing warning parser test**

```ts
assert.deepEqual(
  parseChatStreamPacket('event: warning\ndata: {"warning":"missing file"}\n\n'),
  { kind: 'warning', text: 'missing file' },
);
```

- [ ] **Step 3: Run dashboard tests and verify RED**

```powershell
npm test -- presets-section settings-tab chat-tab useChatComposer chat-stream-parser chatMessages
```

Expected: file controls/warning parsing are missing and old controls still render.

- [ ] **Step 4: Add preset file editing**

Render both booleans for every operation mode. Render ordered file rows:

```tsx
{preset.autoloadFiles.map((file, index) => (
  <div className="preset-autoload-file" key={`${preset.id}:${index}`}>
    <input
      aria-label={`Autoload file ${index + 1}`}
      value={file}
      onChange={(event) => updatePresetDraft(preset.id, (next) => {
        next.autoloadFiles[index] = event.target.value;
      })}
    />
    <button type="button" onClick={() => updatePresetDraft(preset.id, (next) => {
      next.autoloadFiles.splice(index, 1);
    })}>Remove</button>
  </div>
))}
<button type="button" onClick={() => updatePresetDraft(preset.id, (next) => {
  next.autoloadFiles.push('');
})}>+ Add file</button>
```

- [ ] **Step 5: Delete Chat override plumbing**

Delete the preview contract/endpoint client, hook, request fields, helpers, controller state, composer dependency, prompt filtering, ChatTab props, and buttons.

Extend the stream parser with `warning`. `consumeChatStream` accumulates warnings and returns:

```ts
export type ChatStreamResult = {
  response: ChatSessionResponse;
  warnings: string[];
};
```

The composer stores warnings in local state, clears them at send start, and exposes them through `UseChatComposerResult`. `ChatTab` renders a nonfatal warning banner. Do not persist warnings as chat messages.

- [ ] **Step 6: Remove global dashboard controls**

Delete both General fields from `SettingsTab` and `settings-sections.ts`; Task 5 removes their contract/persistence fields.

- [ ] **Step 7: Run dashboard tests and verify GREEN**

```powershell
npm test -- presets-section settings-tab chat-tab useChatComposer chat-stream-parser chatMessages
```

Expected: preset editing and warning display pass; global and Chat override controls are absent.

- [ ] **Step 8: Commit**

```powershell
git add packages/contracts/src/chat.ts dashboard/src dashboard/tests
git commit -m "feat: edit preset startup context in dashboard"
```

---

### Task 5: Delete global config and database fields

**Files:**

- Modify: `packages/contracts/src/config.ts:156`
- Modify: `src/config/defaults.ts:79`
- Modify: `src/config/normalization.ts:436`
- Modify: `src/status-server/config-store.ts:49`
- Modify: `src/state/runtime-db.ts:124`
- Modify: `src/status-server/routes/core.ts:272`
- Test: `tests/config-no-top-level-backend.test.ts`
- Test: `tests/config-normalization.test.ts`
- Test: `tests/runtime-loadconfig.test.ts`
- Test: `tests/dashboard-status-server.test.ts`
- Test: typed config fixtures found by the final obsolete-symbol scan

**Interfaces:**

- Removes: `SiftConfig.IncludeAgentsMd`
- Removes: `SiftConfig.IncludeRepoFileListing`
- Produces: runtime schema version `36`
- Leaves `presets_json` as the only persisted startup-context configuration

- [ ] **Step 1: Write failing canonical-config and migration tests**

```ts
test('canonical config has no global startup-context switches', () => {
  const config = getDefaultConfig();
  assert.equal(Object.hasOwn(config, 'IncludeAgentsMd'), false);
  assert.equal(Object.hasOwn(config, 'IncludeRepoFileListing'), false);
});

test('schema 36 removes startup-context columns', () => {
  const dbPath = tempDbPath('sk-v35-context-migrate-');
  seedVersion35AppConfig(dbPath, JSON.stringify([{
    ...getBuiltinPresets()[0],
    autoloadFiles: ['C:\\shared\\policy.md'],
  }]));
  getRuntimeDatabase(dbPath);
  assert.equal(columnNames(dbPath).includes('include_agents_md'), false);
  assert.equal(columnNames(dbPath).includes('include_repo_file_listing'), false);
  assert.equal(schemaVersion(dbPath), 36);
  assert.match(readPresetsJson(dbPath), /C:\\\\shared\\\\policy\.md/u);
});
```

Implement the suite-local `seedVersion35AppConfig` by copying the exact schema-35 `runtime_schema`/`app_config` DDL from `applyBaseSchema`, inserting one row, and setting version 35. Implement `readPresetsJson` with a Zod row schema:

```ts
const PresetsJsonRowSchema = z.object({ presets_json: z.string() });
```

- [ ] **Step 2: Run focused tests and verify RED**

```powershell
npm test -- config-no-top-level-backend config-normalization runtime-loadconfig dashboard-status-server
```

Expected: removed-field and schema-version assertions fail.

- [ ] **Step 3: Remove the config fields**

Delete both keys from `SiftConfigSchema`, defaults, normalization, strict-payload requirements, `AppConfigRowSchema`, row conversion, SQL SELECT/INSERT columns, and all typed fixtures. Do not read or translate removed keys.

- [ ] **Step 4: Add schema migration 36**

Rebuild `app_config` transactionally with its current columns except `include_agents_md` and `include_repo_file_listing`:

```sql
CREATE TABLE app_config_v36 (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  version TEXT NOT NULL,
  policy_mode TEXT NOT NULL,
  raw_log_retention INTEGER NOT NULL CHECK (raw_log_retention IN (0, 1)),
  expand_reads INTEGER NOT NULL DEFAULT 1 CHECK (expand_reads IN (0, 1)),
  prompt_prefix TEXT,
  runtime_model TEXT,
  thresholds_min_characters_for_summary INTEGER NOT NULL,
  thresholds_min_lines_for_summary INTEGER NOT NULL,
  interactive_enabled INTEGER NOT NULL CHECK (interactive_enabled IN (0, 1)),
  interactive_wrapped_commands_json TEXT NOT NULL,
  interactive_idle_timeout_ms INTEGER NOT NULL,
  interactive_max_transcript_characters INTEGER NOT NULL,
  interactive_transcript_retention INTEGER NOT NULL CHECK (interactive_transcript_retention IN (0, 1)),
  server_llama_presets_json TEXT NOT NULL DEFAULT '[]',
  server_llama_active_preset_id TEXT,
  server_external_server_enabled INTEGER NOT NULL DEFAULT 0 CHECK (server_external_server_enabled IN (0, 1)),
  inference_json TEXT NOT NULL DEFAULT '{}',
  server_exl3_json TEXT NOT NULL DEFAULT '{}',
  operation_mode_allowed_tools_json TEXT NOT NULL,
  presets_json TEXT NOT NULL,
  web_search_json TEXT NOT NULL DEFAULT '{}',
  updated_at_utc TEXT NOT NULL
);
```

Copy retained columns, drop the old table, rename `app_config_v36`, and set schema version 36. Remove historical migrations whose sole effect was adding either deleted column.

- [ ] **Step 5: Run focused tests and verify GREEN**

```powershell
npm test -- config-no-top-level-backend config-normalization runtime-loadconfig dashboard-status-server
```

Expected: config round-trips through preset JSON, obsolete columns disappear, and version 36 passes.

- [ ] **Step 6: Commit**

```powershell
git add packages/contracts/src/config.ts src/config src/status-server/config-store.ts src/state/runtime-db.ts src/status-server/routes/core.ts tests
git commit -m "refactor: remove global startup context settings"
```

---

### Task 6: Documentation, branch coverage, and complete validation

**Files:**

- Modify: `README.md:63`
- Modify: `docs/superpowers/specs/2026-07-28-preset-system-context-design.md`

- [ ] **Step 1: Update documentation**

Add this behavior, using project terminology:

```text
Each preset independently controls AGENTS.md loading, repository file-list loading, and an ordered list of individual autoload files. Relative file paths resolve from the run repository root; absolute PC paths are accepted. Loaded content is labelled and added to the system prompt. Invalid configured files are skipped with a visible warning.
```

Remove descriptions of global settings and first-message Chat overrides.

- [ ] **Step 2: Verify documentation terms**

```powershell
rg -n "autoload files|relative.*repository root|absolute.*path|system prompt" README.md
```

Expected: all four concepts match.

- [ ] **Step 3: Run branch coverage**

```powershell
npm run test:coverage
```

Expected: no uncovered branches remain in `src/preset-system-context.ts`, preset normalization, warning rendering, or route preset selection. Add exact missing-path, empty-file, directory, read-error, relative-path, absolute-path, disabled-source, missing-preset, and warning/no-warning cases for any reported gaps.

- [ ] **Step 4: Confirm obsolete symbols are absent**

```powershell
rg -n "IncludeAgentsMd|IncludeRepoFileListing|RepoSearchAutoAppend|repoSearchAutoAppend|include_agents_md|include_repo_file_listing|buildRepoSearchAutoAppend" src dashboard packages tests
```

Expected: no matches.

- [ ] **Step 5: Run complete validation**

```powershell
npm run typecheck
npm test
npm run build
git diff --check
```

Expected: every command exits 0 and `git diff --check` prints nothing.

- [ ] **Step 6: Commit**

```powershell
git add README.md docs/superpowers/specs/2026-07-28-preset-system-context-design.md
git commit -m "docs: document preset startup context"
```

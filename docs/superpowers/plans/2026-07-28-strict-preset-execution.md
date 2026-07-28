# Strict Preset Execution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate preset fallthroughs and duplicated prompt prefixes while preserving streamed Chat updates and replacing callback-based preset draft mutation with explicit operations.

**Architecture:** Strict preset helpers own exact-ID validation. A reusable Chat operation selector performs explicit built-in transitions, and a reusable prompt composer owns final system-prompt ordering. Dashboard preset editing moves to a typed editor class with named controller/component operations.

**Tech Stack:** TypeScript, Node test runner, Zod-backed contracts, React 19, SQLite, SSE.

## Global Constraints

- Follow TDD: write each behavior test first and verify the expected failure before production edits.
- Prefer HTTP/SSE E2E tests for route, persistence, and streaming behavior.
- No type assertions, `any`, non-null assertions, namespace imports, or domain updater callbacks.
- No compatibility shims or arbitrary preset recovery.
- Do not use a worktree.
- Keep the existing user-owned `package-lock.json` change unstaged and unmodified.
- SiftKit commands remain unavailable until its status server is restored; use exact-file raw inspection only.

---

### Task 1: Make preset metadata lookup strict

**Files:**

- Modify: `src/presets.ts:447-496`
- Modify: `tests/presets.test.ts:248-257`
- Modify: call sites surfaced by TypeScript after deleting `getPresetExecutionFamily`

**Interfaces:**

- Produces: `requirePresetById(presets, presetId): SiftPreset`
- Produces: `requirePresetKind(presets, presetId, allowedKinds): SiftPreset`
- Changes: `getPresetKind` and `getPresetExecutionOperationMode` throw for missing IDs
- Deletes: `getPresetExecutionFamily`

- [ ] **Step 1: Write failing strict-lookup tests**

Replace the missing-ID fallback assertions in `tests/presets.test.ts`:

```ts
test('preset metadata helpers reject a missing preset instead of selecting defaults', () => {
  const presets = normalizePresets([]);

  assert.throws(() => getPresetKind('missing', presets), /Preset 'missing' was not found\./u);
  assert.throws(
    () => getPresetExecutionOperationMode('missing', presets),
    /Preset 'missing' was not found\./u,
  );
});

test('requirePresetKind rejects an exact preset with an incompatible kind', () => {
  const presets = normalizePresets([]);

  assert.throws(
    () => requirePresetKind(presets, 'chat', ['plan']),
    /Preset 'chat' has kind 'chat'; expected: plan\./u,
  );
});
```

The first test catches reintroduction of metadata defaults. The second catches accepting a valid ID at the wrong execution boundary.

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```powershell
npx tsx --test tests/presets.test.ts
```

Expected: missing preset assertions fail because current helpers return `chat`/`summary`; `requirePresetKind` is not exported.

- [ ] **Step 3: Implement strict helpers**

Add:

```ts
export function requirePresetById(
  presets: readonly SiftPreset[],
  presetId: string,
): SiftPreset {
  const preset = findPresetById(presets, presetId);
  if (!preset) {
    throw new Error(`Preset '${presetId}' was not found.`);
  }
  return preset;
}

export function requirePresetKind(
  presets: readonly SiftPreset[],
  presetId: string,
  allowedKinds: readonly PresetKind[],
): SiftPreset {
  const preset = requirePresetById(presets, presetId);
  if (!allowedKinds.includes(preset.presetKind)) {
    throw new Error(
      `Preset '${preset.id}' has kind '${preset.presetKind}'; expected: ${allowedKinds.join(', ')}.`,
    );
  }
  return preset;
}
```

Make metadata helpers read from `requirePresetById`. Delete `getPresetExecutionFamily` and repair only real typed call sites; do not add replacement defaults.

- [ ] **Step 4: Run tests and typecheck**

Run:

```powershell
npx tsx --test tests/presets.test.ts
npm run typecheck
```

Expected: both exit 0.

- [ ] **Step 5: Commit**

```powershell
git add src/presets.ts tests/presets.test.ts
git commit -m "refactor: require exact preset metadata"
```

---

### Task 2: Centralize system-prompt composition

**Files:**

- Create: `src/preset-system-prompt.ts`
- Create: `tests/preset-system-prompt.test.ts`
- Modify: `src/repo-search/prompts.ts:211-335`
- Modify: `src/repo-search/types.ts:57-76`
- Modify: `src/repo-search/execute.ts:315-350`
- Modify: `src/status-server/preset-runner.ts:203-250`
- Modify: `src/status-server/routes/core.ts:900-920`
- Modify: `src/status-server/routes/chat.ts:705-975,1090-1440`
- Modify: `src/status-server/chat-prompt-context.ts:48-100`
- Modify: `tests/dashboard-status-server.test.ts`

**Interfaces:**

- Produces: `PresetSystemPromptComposer`
- Renames internal request field: `promptPrefix` → `additionalPromptPrefix`
- Public HTTP `promptPrefix` remains a genuine additional prefix and maps to `additionalPromptPrefix`
- `buildTaskSystemPrompt` and `buildAgentSystemPrompt` return base instructions without appending context content

- [ ] **Step 1: Write failing prompt-composer tests**

Create `tests/preset-system-prompt.test.ts`:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';

import { PresetSystemPromptComposer } from '../src/preset-system-prompt.js';

const context = {
  content: '--- Autoloaded file: rules.md ---\n\nLoaded rules.',
  warnings: [],
  hasAgentsMd: false,
  hasRepoFileListing: false,
  loadedFiles: ['rules.md'],
};

test('composer includes the preset prefix exactly once', () => {
  const composer = new PresetSystemPromptComposer('Preset instructions.', context);

  assert.equal(
    composer.compose('Base system prompt.'),
    [
      'Preset instructions.',
      'Base system prompt.',
      '--- Autoloaded file: rules.md ---\n\nLoaded rules.',
    ].join('\n\n'),
  );
});

test('composer places a genuine additional prefix after the preset prefix', () => {
  const composer = new PresetSystemPromptComposer('Preset instructions.', context);

  assert.equal(
    composer.compose('Base system prompt.', 'Benchmark addition.'),
    [
      'Preset instructions.',
      'Benchmark addition.',
      'Base system prompt.',
      '--- Autoloaded file: rules.md ---\n\nLoaded rules.',
    ].join('\n\n'),
  );
});
```

These tests catch duplicate prefix insertion and incorrect section order using hand-derived literals.

- [ ] **Step 2: Run the composer tests and verify RED**

Run:

```powershell
npx tsx --test tests/preset-system-prompt.test.ts
```

Expected: module/export missing.

- [ ] **Step 3: Implement the reusable composer**

Create:

```ts
import type { PresetSystemContext } from './preset-system-context.js';

export class PresetSystemPromptComposer {
  constructor(
    private readonly presetPromptPrefix: string,
    private readonly systemContext: PresetSystemContext,
  ) {}

  compose(baseSystemPrompt: string, additionalPromptPrefix: string = ''): string {
    return [
      this.presetPromptPrefix.trim(),
      additionalPromptPrefix.trim(),
      baseSystemPrompt.trim(),
      this.systemContext.content,
    ].filter(Boolean).join('\n\n');
  }
}
```

Refactor task/agent prompt builders so they use context metadata for their file-list guidance but do not append `context.content`.

- [ ] **Step 4: Run composer and repo prompt tests**

Run:

```powershell
npx tsx --test tests/preset-system-prompt.test.ts tests/repo-search-prompts.test.ts
```

Expected: both pass after updating prompt expectations to one labelled system-context block.

- [ ] **Step 5: Write a failing HTTP integration assertion for exact prefix count**

Extend the existing captured `/v1/chat/completions` request test in `tests/dashboard-status-server.test.ts`. Configure the selected Chat preset with:

```ts
chatConfig.Presets = chatConfig.Presets.map((preset) => (
  preset.id === 'chat'
    ? { ...preset, promptPrefix: 'UNIQUE_PRESET_PREFIX' }
    : preset
));
```

After parsing `capturedChatRawBody`, assert:

```ts
const systemText = asObjectArray(captured.messages)
  .filter((message) => message.role === 'system')
  .map((message) => String(message.content || ''))
  .join('\n');

assert.equal(systemText.match(/UNIQUE_PRESET_PREFIX/gu)?.length, 1);
```

This fails if either the caller and executor both add the prefix or neither adds it.

- [ ] **Step 6: Run the integration test and verify RED**

Run:

```powershell
npm test -- dashboard-status-server
```

Expected: exact-count assertion reports `2` with current prefix forwarding.

- [ ] **Step 7: Make the executor the sole prompt owner**

In `RepoSearchExecutionRequest`, rename the internal property to `additionalPromptPrefix`.

In `executeRepoSearchRequest`:

```ts
const preset = requirePresetById(normalizePresets(config.Presets), request.presetId);
const systemContext = new PresetSystemContextBuilder(repoRoot).build(preset);
const baseSystemPrompt = isAgent
  ? buildAgentSystemPrompt(systemContext)
  : taskKind === 'chat'
    ? request.systemPrompt || ''
    : buildTaskSystemPrompt(systemContext);
const systemPromptOverride = new PresetSystemPromptComposer(
  preset.promptPrefix,
  systemContext,
).compose(baseSystemPrompt, request.additionalPromptPrefix);
```

Callers:

- `StatusPresetRunner` passes only `presetId`; delete its preset-prefix argument.
- Chat direct routes call `buildChatSystemContent(config, session)` without a preset prefix.
- Chat plan/repo-search routes pass no preset-owned prefix.
- Core repo-search HTTP maps `reader.optionalString('promptPrefix')` to `additionalPromptPrefix`.
- `buildChatPromptContext` uses the same composer.

- [ ] **Step 8: Run focused tests and verify GREEN**

Run:

```powershell
npx tsx --test tests/preset-system-prompt.test.ts tests/repo-search-prompts.test.ts
npm test -- dashboard-status-server preset-execution summary-request-runner
```

Expected: all exit 0; captured system text contains the prefix once.

- [ ] **Step 9: Commit**

```powershell
git add src/preset-system-prompt.ts src/repo-search src/status-server tests/preset-system-prompt.test.ts tests/repo-search-prompts.test.ts tests/dashboard-status-server.test.ts
git commit -m "refactor: centralize preset system prompts"
```

---

### Task 3: Switch Chat operations explicitly and preserve streamed updates

**Files:**

- Create: `src/status-server/chat-operation-preset.ts`
- Create: `tests/chat-operation-preset.test.ts`
- Modify: `src/status-server/routes/chat.ts`
- Modify: `src/status-server/chat-prompt-context.ts`
- Modify: `src/summary/request-runner.ts`
- Modify: `src/status-server/preset-runner.ts`
- Modify: `tests/dashboard-status-server.test.ts`
- Modify: `tests/streamed-op-endpoints.test.ts`

**Interfaces:**

- Produces: `ChatOperationPresetSelector`
- Produces: `{ preset: SiftPreset; session: ChatSession }`
- Keeps compatible custom presets
- Explicitly transitions incompatible operations to exact built-ins
- Never selects the first compatible preset

- [ ] **Step 1: Write failing selector tests**

Create `tests/chat-operation-preset.test.ts` with a complete `ChatSession` fixture and normalized presets:

```ts
test('selector keeps a compatible custom plan preset', () => {
  const planPreset = requirePresetById(getBuiltinPresets(), 'plan');
  const presets = normalizePresets([{
    ...planPreset,
    id: 'custom-plan',
    label: 'Custom Plan',
    builtin: false,
    deletable: true,
  }]);
  const session = createSession('custom-plan', 'plan');

  const selected = new ChatOperationPresetSelector(presets).select(session, 'plan');

  assert.equal(selected.preset.id, 'custom-plan');
  assert.equal(selected.session.presetId, 'custom-plan');
});

test('selector explicitly switches an incompatible chat preset to built-in plan', () => {
  const session = createSession('chat', 'chat');

  const selected = new ChatOperationPresetSelector(normalizePresets([])).select(session, 'plan');

  assert.equal(selected.preset.id, 'plan');
  assert.equal(selected.session.presetId, 'plan');
  assert.equal(selected.session.mode, 'plan');
});

test('selector fails when the required built-in transition preset is absent', () => {
  const chatOnly = getBuiltinPresets().filter((preset) => preset.id === 'chat');

  assert.throws(
    () => new ChatOperationPresetSelector(chatOnly).select(createSession('chat'), 'plan'),
    /Preset 'plan' was not found\./u,
  );
});
```

- [ ] **Step 2: Run selector tests and verify RED**

Run:

```powershell
npx tsx --test tests/chat-operation-preset.test.ts
```

Expected: module/export missing.

- [ ] **Step 3: Implement the selector**

Implement:

```ts
export class ChatOperationPresetSelector {
  constructor(private readonly presets: readonly SiftPreset[]) {}

  select(session: ChatSession, operation: ChatPresetOperation): SelectedChatOperationPreset {
    const selected = findPresetById(this.presets, session.presetId);
    if (selected && isCompatible(selected.presetKind, operation)) {
      return { preset: selected, session };
    }
    const preset = requirePresetKind(this.presets, operation, [operation]);
    return {
      preset,
      session: {
        ...session,
        presetId: preset.id,
        mode: operation,
      },
    };
  }
}
```

Implement `chat` compatibility explicitly for `chat | summary`; do not pass a predicate function into the selector.

- [ ] **Step 4: Run selector tests and verify GREEN**

Run:

```powershell
npx tsx --test tests/chat-operation-preset.test.ts
```

Expected: pass.

- [ ] **Step 5: Write failing HTTP/SSE switch tests**

Add live-server cases to `tests/dashboard-status-server.test.ts`:

```ts
assert.equal(String(d(planMessage.body.session).presetId), 'plan');
assert.equal(String(d(planMessage.body.session).mode), 'plan');
```

For the streamed plan endpoint, inspect the terminal `done` event:

```ts
const done = response.events.find((event) => event.event === 'done');
const doneSession = d(d(done?.data).session);
assert.equal(doneSession.presetId, 'plan');
assert.equal(doneSession.mode, 'plan');
```

Add create/update cases with a non-empty unknown `presetId` and assert a non-2xx response plus no persisted unknown ID.

- [ ] **Step 6: Run route tests and verify RED**

Run:

```powershell
npm test -- dashboard-status-server streamed-op-endpoints
```

Expected: current session fallthrough paths either preserve the wrong ID, accept an unknown ID, or do not expose an authoritative switched session.

- [ ] **Step 7: Replace every Chat route fallback**

Use `ChatOperationPresetSelector` before Chat, Plan, and Repo Search engine calls. Use its returned `preset` for execution and its returned `session` for prompt/history construction and final persistence.

Session writes:

- Create: omitted ID explicitly uses `chat`; a supplied ID uses `requirePresetById`.
- Update: supplied ID uses `requirePresetById`; remove raw-ID persistence.
- Remove `updateRequest.mode` as a preset-selection path; `mode` is derived from the exact preset.
- Remove `resolveRepoSearchRoutePreset`, `preset?.id || ...`, `chatPreset?.id || ...`, and session persistence fallback chains.

For streamed endpoints, keep existing progress forwarding. Build the final `done` event from the persisted selected session so `useChatComposer` receives and applies the switched `presetId` and `mode`.

Replace explicit-ID `findPresetById` calls in summary, repo execution, preset runner, and prompt context with `requirePresetById`.

- [ ] **Step 8: Run backend tests and verify GREEN**

Run:

```powershell
npx tsx --test tests/chat-operation-preset.test.ts tests/presets.test.ts
npm test -- dashboard-status-server streamed-op-endpoints route-request-normalizers
```

Expected: all pass; both non-stream and stream responses carry the switched session.

- [ ] **Step 9: Commit**

```powershell
git add src/presets.ts src/summary src/repo-search src/status-server tests
git commit -m "refactor: make preset transitions explicit"
```

---

### Task 4: Remove dashboard preset and prompt fallthroughs

**Files:**

- Modify: `dashboard/src/dashboard-presets.ts`
- Modify: `dashboard/src/hooks/useChatController.ts`
- Modify: `dashboard/src/hooks/useChatSessions.ts`
- Modify: `dashboard/src/tabs/ChatTab.tsx`
- Modify: `dashboard/src/lib/chatMessages.ts`
- Modify: `tests/dashboard-presets.test.ts`
- Modify: `dashboard/tests/lib/chatMessages.test.ts`
- Modify: `dashboard/tests/chat-tab.test.tsx`

**Interfaces:**

- `getPresetFamily(...): DashboardPresetKind | null`
- `getDefaultWebPresetId(...): string | null`
- `buildCreateSessionRequest(): CreateChatSessionRequest | null`
- Deletes: `buildFallbackPromptContext`

- [ ] **Step 1: Write failing dashboard resolution tests**

Update `tests/dashboard-presets.test.ts`:

```ts
test('getPresetFamily returns null when configuration is unavailable', () => {
  assert.equal(getPresetFamily(null, createSession('repo-search', 'repo-search')), null);
});

test('getPresetFamily returns null for an unknown session preset', () => {
  assert.equal(getPresetFamily(createConfig([createPreset('chat')]), createSession('missing')), null);
});

test('getDefaultWebPresetId returns null when no web preset exists', () => {
  assert.equal(getDefaultWebPresetId(createConfig([])), null);
});
```

Delete tests for synthetic fallback prompt content from `dashboard/tests/lib/chatMessages.test.ts`; add a rendered Chat-tab assertion that no system-context card is shown until `selectedSession.promptContext` exists.

- [ ] **Step 2: Run dashboard tests and verify RED**

Run:

```powershell
npx tsx --test tests/dashboard-presets.test.ts
npx tsx --test dashboard/tests/lib/chatMessages.test.ts dashboard/tests/chat-tab.test.tsx
```

Expected: family/default helpers return fallbacks and Chat renders synthesized prompt context.

- [ ] **Step 3: Remove dashboard fallthroughs**

- Make family/default helpers nullable.
- Select `selectedChatPreset` only by exact session `presetId`.
- Remove mode and first-web-preset recovery in `useChatController`.
- Make `useChatSessions` skip session creation when its request builder returns `null`.
- Remove `buildFallbackPromptContext` and its imports.
- Render prompt context only from `selectedSession.promptContext`.
- Keep `applySessionResponse` unchanged so the existing terminal stream response updates selected session and preset.

- [ ] **Step 4: Run dashboard tests and typecheck**

Run:

```powershell
npx tsx --test tests/dashboard-presets.test.ts
npx tsx --test dashboard/tests/lib/chatMessages.test.ts dashboard/tests/chat-tab.test.tsx dashboard/tests/hooks/useChatComposer.test.tsx
npm run typecheck
```

Expected: all pass.

- [ ] **Step 5: Commit**

```powershell
git add dashboard/src dashboard/tests tests/dashboard-presets.test.ts
git commit -m "refactor: remove dashboard preset fallthroughs"
```

---

### Task 5: Replace callback preset mutation with explicit operations

**Files:**

- Create: `dashboard/src/preset-draft-editor.ts`
- Create: `dashboard/tests/preset-draft-editor.test.ts`
- Modify: `dashboard/src/hooks/useSettingsController.ts:150-220`
- Modify: `dashboard/src/tabs/SettingsTab.tsx`
- Modify: `dashboard/src/tabs/settings/PresetsSection.tsx`
- Modify: `dashboard/tests/presets-section.test.tsx`
- Modify: `dashboard/tests/settings-tab.test.tsx`

**Interfaces:**

- Produces: `DashboardPresetDraftEditor`
- Deletes: `updatePresetDraft(presetId, updater)`
- Deletes from `PresetsSection`: `updateSettingsDraft`
- Produces the named operations listed in the design spec

- [ ] **Step 1: Write failing editor behavior tests**

Create `dashboard/tests/preset-draft-editor.test.ts`:

```ts
test('preset draft editor applies explicit context and autoload operations', () => {
  const editor = new DashboardPresetDraftEditor(DASHBOARD_CONFIG);

  editor.setAgentsMdEnabled(CUSTOM_PRESET.id, false);
  editor.setRepoFileListingEnabled(CUSTOM_PRESET.id, false);
  editor.addAutoloadFile(CUSTOM_PRESET.id);
  editor.setAutoloadFile(CUSTOM_PRESET.id, 0, 'docs/rules.md');
  editor.addAutoloadFile(CUSTOM_PRESET.id);
  editor.removeAutoloadFile(CUSTOM_PRESET.id, 1);

  const preset = editor.getConfig().Presets.find((entry) => entry.id === CUSTOM_PRESET.id);
  assert.ok(preset);
  assert.equal(preset.includeAgentsMd, false);
  assert.equal(preset.includeRepoFileListing, false);
  assert.deepEqual(preset.autoloadFiles, ['docs/rules.md']);
});

test('preset draft editor updates default summary selection explicitly', () => {
  const editor = new DashboardPresetDraftEditor(DASHBOARD_CONFIG);

  editor.setDefaultSummaryPreset(CUSTOM_PRESET.id, true);

  assert.deepEqual(
    editor.getConfig().Presets.filter((preset) => preset.useForSummary).map((preset) => preset.id),
    [CUSTOM_PRESET.id],
  );
});
```

The class clones input in its constructor, requires exact preset IDs, and returns a synchronized config without exposing mutable input.

- [ ] **Step 2: Run editor tests and verify RED**

Run:

```powershell
npx tsx --test dashboard/tests/preset-draft-editor.test.ts
```

Expected: module/export missing.

- [ ] **Step 3: Implement the typed editor class**

Implement explicit methods matching the approved spec. Use a private exact preset lookup:

```ts
private requirePreset(presetId: string): DashboardPreset {
  const preset = this.config.Presets.find((entry) => entry.id === presetId);
  if (!preset) {
    throw new Error(`Dashboard preset '${presetId}' was not found.`);
  }
  return preset;
}
```

`getConfig()` returns `syncDerivedSettingsFields(this.config)`. Do not accept callbacks, arbitrary property keys, or untyped update objects.

- [ ] **Step 4: Run editor tests and verify GREEN**

Run:

```powershell
npx tsx --test dashboard/tests/preset-draft-editor.test.ts
```

Expected: pass.

- [ ] **Step 5: Refactor controller/component through named operations**

In `useSettingsController`, each named controller operation constructs an editor directly inside its private React setter:

```ts
function setPresetAgentsMdEnabled(presetId: string, enabled: boolean): void {
  setDashboardConfig((previous) => {
    if (!previous) return previous;
    const editor = new DashboardPresetDraftEditor(previous);
    editor.setAgentsMdEnabled(presetId, enabled);
    return editor.getConfig();
  });
  setSettingsSavedAtUtc(null);
}
```

Implement the other named methods with the same explicit shape. Pass these named methods through `SettingsTabProps` and `PresetsSectionProps`. Replace every inline `updatePresetDraft` and preset-specific `updateSettingsDraft` callback.

- [ ] **Step 6: Run focused dashboard tests**

Run:

```powershell
npx tsx --test dashboard/tests/preset-draft-editor.test.ts dashboard/tests/presets-section.test.tsx dashboard/tests/settings-tab.test.tsx
npm run typecheck
```

Expected: all pass; TypeScript confirms no removed callback prop remains.

- [ ] **Step 7: Commit**

```powershell
git add dashboard/src dashboard/tests
git commit -m "refactor: make preset draft operations explicit"
```

---

### Task 6: Audit fallthroughs and complete validation

**Files:**

- Modify only files required by failing behavior tests or typecheck
- Do not modify `package-lock.json`

- [ ] **Step 1: Audit preset resolution without adding source-text tests**

Run:

```powershell
rg -n "\?\.id \|\||getPresetFamily\(.*mode|mapLegacyModeToPresetId|resolveRepoSearchRoutePreset|buildFallbackPromptContext|promptPrefix: preset\??\.promptPrefix|updatePresetDraft\(.*updater" src dashboard packages tests
```

Expected: no execution, dashboard resolution, prompt forwarding, or callback-mutator matches. Historical migration identifiers and deliberate derived `mode` serialization are allowed only where they do not select a preset.

- [ ] **Step 2: Run focused branch coverage**

Run:

```powershell
npm run test:coverage
```

Expected: exit 0; strict missing-ID, incompatible-kind, compatible custom preset, explicit switch, no-web-preset, prompt no-warning/warning, and streamed `done` branches are covered.

- [ ] **Step 3: Run complete validation**

Run:

```powershell
npm run typecheck
npm test
npm run build
git diff --check
```

Expected:

- Typecheck/lint exits 0.
- Full tests report 0 failures.
- Production build exits 0.
- `git diff --check` prints nothing.
- `git status --short` shows only the pre-existing unstaged `package-lock.json` change.

- [ ] **Step 4: Review the commit series**

Run:

```powershell
git log -6 --oneline
git status --short
```

Expected: design, plan, and five implementation commits are present; `package-lock.json` remains unstaged.

# Thinking And Read Controls Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add boolean controls for `MaintainPerStepThinking` and `ExpandReads`, covering thinking retention and repeated read-window expansion behavior.

**Architecture:** Treat the persisted transcript as the source of truth for thinking retention. `MaintainPerStepThinking` lives on managed llama presets and controls WYSIWYG thinking retention. `ExpandReads` lives on the General settings page and gates only the automatic narrow-read expansion rewrite; read overlap accounting and returned-range tracking stay active when expansion is off. Existing `enable_thinking`, `reasoning_content`, and `preserve_thinking` keep their current llama.cpp meanings.

**Tech Stack:** TypeScript, React dashboard, Node status server, repo-search read window governor, llama.cpp chat-template kwargs, `node:test`.

---

## Semantics

- `Reasoning === 'off'`
  - `enable_thinking=false`.
  - `MaintainPerStepThinking=false`.
  - No thinking should be generated or retained.
- `Reasoning === 'on'` with missing `MaintainPerStepThinking`
  - Default to `MaintainPerStepThinking=true`.
  - This preserves current behavior for existing configs that enable thinking.
- `MaintainPerStepThinking=true`
  - Keep every `assistant_thinking` transcript message.
  - Keep every prior planner/tool-call `reasoning_content` block in the active loop transcript.
  - Replay all retained thinking blocks when `PreserveThinking` and `ReasoningContent` allow `reasoning_content` replay.
- `MaintainPerStepThinking=false`
  - Keep only the newest thinking block in visible/persisted transcript state.
  - Delete older `assistant_thinking` messages from `ChatSession.messages`.
  - Remove older `reasoning_content` fields from active repo-search/chat planner transcript messages.
  - Repo-search/tool-call thinking follows the same rule: prior tool-call-step thinking is removed when newer thinking appears.
  - Normal answer, user, and tool messages remain untouched.
- `PreserveThinking`
  - Still controls whether llama.cpp receives `preserve_thinking=true`.
  - It does not decide how many thinking blocks exist in the SiftKit transcript.
- `ExpandReads=true`
  - Preserve current repeated-read behavior.
  - If a later `Get-Content` read window is too narrow, `ReadWindowGovernor.planAdjustment()` can expand/shift it before execution.
  - Overlap accounting still records executed and returned ranges.
- `ExpandReads=false`
  - Do not rewrite narrow reads to larger windows.
  - Keep overlap accounting, returned-range tracking, fit-truncation rollback, and duplicate/overlap metrics.
  - This setting changes what command runs, not how read history is measured.

## Files

- Modify: `src/config/types.ts`
  - Add `MaintainPerStepThinking: boolean` to `ManagedLlamaPreset`.
  - Add `ExpandReads: boolean` to `SiftConfig`.
- Modify: `src/config/defaults.ts`
  - Add default `MaintainPerStepThinking: false` to the base preset because `Reasoning` defaults to `off`.
  - Add default `ExpandReads: true` to preserve existing read expansion behavior.
- Modify: `src/config/normalization.ts`
  - Normalize the field as `reasoningEnabled && input.MaintainPerStepThinking !== false`.
  - Normalize `ExpandReads` as `input.ExpandReads !== false`.
- Modify: `dashboard/src/types.ts`
  - Add `MaintainPerStepThinking: boolean` to dashboard managed llama preset types.
- Modify: `dashboard/src/types.d.ts`
  - Add the API type field if this declaration still mirrors dashboard runtime types.
- Modify: `dashboard/src/tabs/settings/ManagedLlamaSection.tsx`
  - Add the toggle and keep it visible whenever `Reasoning === 'on'`.
- Modify: `dashboard/src/tabs/SettingsTab.tsx`
  - Add the `Expand reads` toggle on the General settings page.
- Modify: `dashboard/src/settings-sections.ts`
  - Add help text for `Maintain per step thinking`.
  - Add help text for `Expand reads`.
- Modify: `dashboard/src/lib/live-thinking-message.ts`
  - Add WYSIWYG live pruning when the setting is `false`.
- Modify: `dashboard/src/hooks/useLiveMessages.ts`
  - Pass the retention boolean into live thinking appends.
- Modify: `dashboard/src/hooks/useChatComposer.ts`
  - Derive/pass the retention boolean for direct chat, plan, and repo-search streams.
- Modify: `dashboard/src/App.tsx`
  - Derive the active managed preset's retention setting and pass it to the composer.
- Create: `src/thinking-retention-policy.ts`
  - Centralize explicit retention operations for persisted session messages and planner transcript messages.
- Modify: `src/status-server/chat.ts`
  - Use the retention policy for persistence and replay.
- Modify: `src/status-server/routes/chat.ts`
  - Resolve `MaintainPerStepThinking` from the active managed preset and pass it to persistence.
- Modify: `src/repo-search/engine/task-loop-support.ts`
  - Add `isPlannerMaintainPerStepThinkingEnabled`.
- Modify: `src/repo-search/engine/task-loop.ts`
  - Apply the setting to active planner transcript `reasoning_content` and `turnThinking`.
- Modify: `src/repo-search/engine/transcript-manager.ts`
  - Add explicit methods for pruning older planner thinking.
- Modify: `src/repo-search/engine/read-window-governor.ts`
  - Add an explicit `expandReads` option to `planAdjustment`.
- Modify: `src/repo-search/engine/tool-action-processor.ts`
  - Pass the configured `ExpandReads` value into `ReadWindowGovernor.planAdjustment`.
- Modify: `src/repo-search/engine/task-loop.ts`
  - Resolve `ExpandReads` from config and pass it to `ToolActionProcessor`.
- Modify tests:
  - `tests/dashboard-managed-presets.test.ts`
  - `tests/dashboard-presets.test.ts`
  - `tests/settings-runtime.test.ts`
  - `tests/status-server-chat.test.ts`
  - `tests/repo-search-chat-loop.test.ts`
  - `tests/engine-read-window-governor.test.ts`
  - `dashboard/tests/live-thinking-message.test.ts`
  - `dashboard/tests/tab-components.test.tsx`

---

### Task 1: Add Config Field And Defaults

**Files:**
- Modify: `src/config/types.ts`
- Modify: `src/config/defaults.ts`
- Modify: `src/config/normalization.ts`
- Test: `tests/dashboard-managed-presets.test.ts`
- Test: `tests/dashboard-presets.test.ts`
- Test: `tests/settings-runtime.test.ts`

- [ ] **Step 1: Write failing thinking normalization tests**

Add tests that lock the three required states:

```ts
test('managed llama preset defaults MaintainPerStepThinking on when reasoning is enabled', () => {
  const config = normalizeConfig({
    Server: {
      LlamaCpp: {
        Presets: [{
          id: 'thinking-on',
          label: 'Thinking On',
          Reasoning: 'on',
          ReasoningContent: true,
          PreserveThinking: true,
        }],
        ActivePresetId: 'thinking-on',
      },
    },
  });

  const preset = config.Server.LlamaCpp.Presets[0];
  assert.equal(preset.Reasoning, 'on');
  assert.equal(preset.MaintainPerStepThinking, true);
});

test('managed llama preset honors explicit MaintainPerStepThinking false when reasoning is enabled', () => {
  const config = normalizeConfig({
    Server: {
      LlamaCpp: {
        Presets: [{
          id: 'thinking-on-last-only',
          label: 'Thinking On Last Only',
          Reasoning: 'on',
          ReasoningContent: true,
          PreserveThinking: true,
          MaintainPerStepThinking: false,
        }],
        ActivePresetId: 'thinking-on-last-only',
      },
    },
  });

  assert.equal(config.Server.LlamaCpp.Presets[0].MaintainPerStepThinking, false);
});

test('managed llama preset disables MaintainPerStepThinking when reasoning is disabled', () => {
  const config = normalizeConfig({
    Server: {
      LlamaCpp: {
        Presets: [{
          id: 'thinking-off',
          label: 'Thinking Off',
          Reasoning: 'off',
          MaintainPerStepThinking: true,
        }],
        ActivePresetId: 'thinking-off',
      },
    },
  });

  assert.equal(config.Server.LlamaCpp.Presets[0].MaintainPerStepThinking, false);
});
```

- [ ] **Step 2: Write failing ExpandReads normalization tests**

Add these tests to `tests/dashboard-presets.test.ts` beside the tests that already validate normalized dashboard config shape.

```ts
test('config defaults ExpandReads to true', () => {
  const config = normalizeConfig({});

  assert.equal(config.ExpandReads, true);
});

test('config honors explicit ExpandReads false', () => {
  const config = normalizeConfig({
    ExpandReads: false,
  });

  assert.equal(config.ExpandReads, false);
});

test('config normalizes non-false ExpandReads values to true', () => {
  const config = normalizeConfig({
    ExpandReads: 'no',
  });

  assert.equal(config.ExpandReads, true);
});
```

- [ ] **Step 3: Run config tests and verify failure**

Run:

```powershell
npm test -- dashboard-managed-presets
npm test -- dashboard-presets
npm test -- settings-runtime
```

Expected:

- Type or assertion failures because `MaintainPerStepThinking` and `ExpandReads` are missing from config types/defaults/normalization.

- [ ] **Step 4: Add the fields to config types**

In `src/config/types.ts`, extend `ManagedLlamaPreset`:

```ts
  Reasoning: 'on' | 'off';
  ReasoningContent: boolean;
  PreserveThinking: boolean;
  MaintainPerStepThinking: boolean;
```

In `src/config/types.ts`, extend `SiftConfig` near the existing General fields:

```ts
  RawLogRetention: boolean;
  IncludeAgentsMd: boolean;
  IncludeRepoFileListing: boolean;
  ExpandReads: boolean;
  PromptPrefix?: string | null;
```

In `src/config/normalization.ts`, extend `ServerManagedLlamaPreset`:

```ts
  Reasoning: 'on' | 'off';
  ReasoningContent: boolean;
  PreserveThinking: boolean;
  MaintainPerStepThinking: boolean;
```

- [ ] **Step 5: Add the defaults**

In `src/config/defaults.ts`, add the default beside `PreserveThinking`:

```ts
    Reasoning: 'off' as const,
    ReasoningContent: false,
    PreserveThinking: false,
    MaintainPerStepThinking: false,
```

In `src/config/defaults.ts`, add the General default beside `IncludeRepoFileListing`:

```ts
    RawLogRetention: true,
    IncludeAgentsMd: true,
    IncludeRepoFileListing: true,
    ExpandReads: true,
    PromptPrefix: SIFT_DEFAULT_PROMPT_PREFIX,
```

- [ ] **Step 6: Normalize the fields**

In `resolveManagedLlamaSettings` in `src/config/normalization.ts`, keep the existing `reasoningContentEnabled` local and add a separate reasoning boolean:

```ts
  const reasoningEnabled = reasoning === 'on';
  const reasoningContentEnabled = reasoningEnabled && input.ReasoningContent === true;
```

Then include:

```ts
    ReasoningContent: reasoningContentEnabled,
    PreserveThinking: reasoningContentEnabled && input.PreserveThinking === true,
    MaintainPerStepThinking: reasoningEnabled && input.MaintainPerStepThinking !== false,
```

In `normalizeConfig`, after `merged.IncludeRepoFileListing` is available through defaults, add:

```ts
  merged.ExpandReads = merged.ExpandReads !== false;
```

Do not support legacy aliases.

- [ ] **Step 7: Update existing managed-preset and config fixtures**

Add `MaintainPerStepThinking` to test fixture objects that currently include `ReasoningContent` and `PreserveThinking`.

Use:

```ts
MaintainPerStepThinking: false
```

for fixtures where `Reasoning: 'off'`.

Use:

```ts
MaintainPerStepThinking: true
```

for fixtures where `Reasoning: 'on'` and thinking is expected to be active.

Add `ExpandReads: true` to full `DashboardConfig` fixtures that spell out General fields.

- [ ] **Step 8: Re-run config tests**

Run:

```powershell
npm test -- dashboard-managed-presets
npm test -- dashboard-presets
npm test -- settings-runtime
```

Expected:

- PASS.

---

### Task 2: Add Dashboard Settings Toggle

**Files:**
- Modify: `dashboard/src/types.ts`
- Modify: `dashboard/src/types.d.ts`
- Modify: `dashboard/src/settings-sections.ts`
- Modify: `dashboard/src/tabs/settings/ManagedLlamaSection.tsx`
- Test: `dashboard/tests/tab-components.test.tsx`

- [ ] **Step 1: Write failing dashboard render tests**

In `dashboard/tests/tab-components.test.tsx`, update `MANAGED_PRESET` to include:

```ts
MaintainPerStepThinking: false,
```

Add or extend the existing thinking-controls test:

```ts
test('managed llama section shows maintain per step thinking when reasoning is enabled', () => {
  const capturedFields: string[] = [];
  const markup = renderToStaticMarkup(
    <ManagedLlamaSection
      dashboardConfig={DASHBOARD_CONFIG}
      selectedManagedLlamaPreset={{
        ...MANAGED_PRESET,
        Reasoning: 'on',
        ReasoningContent: false,
        PreserveThinking: false,
        MaintainPerStepThinking: true,
      }}
      settingsActionBusy={false}
      settingsPathPickerBusyTarget={null}
      renderField={(_, label, children) => {
        capturedFields.push(label);
        return <div>{children}</div>;
      }}
      updateSettingsDraft={() => {}}
      updateManagedLlamaDraft={() => {}}
      onAddManagedLlamaPreset={() => {}}
      onDeleteManagedLlamaPreset={() => {}}
      onPickManagedLlamaPath={async () => {}}
    />,
  );

  assert.equal(capturedFields.includes('Maintain per step thinking'), true);
  assert.match(markup, /Enabled/);
});
```

Add an interaction-style unit test using the component function pattern already used near `managed llama model name is derived from model path`:

```ts
test('managed llama section turns maintain per step thinking on when reasoning is enabled', () => {
  let updatedConfig: DashboardConfig | null = null;

  const section = ManagedLlamaSection({
    dashboardConfig: DASHBOARD_CONFIG,
    selectedManagedLlamaPreset: {
      ...MANAGED_PRESET,
      Reasoning: 'off',
      ReasoningContent: false,
      PreserveThinking: false,
      MaintainPerStepThinking: false,
    },
    settingsActionBusy: false,
    settingsPathPickerBusyTarget: null,
    renderField: (_, __, children) => <div>{children}</div>,
    updateSettingsDraft: () => {},
    updateManagedLlamaDraft: (updater) => {
      const nextConfig = structuredClone(DASHBOARD_CONFIG);
      const preset = nextConfig.Server.LlamaCpp.Presets[0];
      updater(preset);
      updatedConfig = nextConfig;
    },
    onAddManagedLlamaPreset: () => {},
    onDeleteManagedLlamaPreset: () => {},
    onPickManagedLlamaPath: async () => {},
  });

  const select = findElementByType(section, 'select');
  select.props.onChange({ target: { value: 'on' } });

  assert.ok(updatedConfig);
  assert.equal(updatedConfig.Server.LlamaCpp.Presets[0]?.Reasoning, 'on');
  assert.equal(updatedConfig.Server.LlamaCpp.Presets[0]?.MaintainPerStepThinking, true);
});
```

- [ ] **Step 2: Run dashboard component test and verify failure**

Run:

```powershell
npm test -- tab-components
```

Expected:

- Type/render failures because dashboard types and control do not include `MaintainPerStepThinking`.

- [ ] **Step 3: Add dashboard/API type fields**

In `dashboard/src/types.ts`, add:

```ts
  Reasoning: 'on' | 'off';
  ReasoningContent: boolean;
  PreserveThinking: boolean;
  MaintainPerStepThinking: boolean;
```

Apply the same field to `dashboard/src/types.d.ts` if the managed llama preset declaration exists there.

- [ ] **Step 4: Add settings help text**

In `dashboard/src/settings-sections.ts`, insert this field after `Preserve thinking`:

```ts
      { label: 'Maintain per step thinking', layout: 'quarter', helpText: 'When enabled, all visible thinking blocks are retained. When disabled, only the latest thinking block remains in the transcript.' },
```

- [ ] **Step 5: Add the toggle**

In `dashboard/src/tabs/settings/ManagedLlamaSection.tsx`, keep the existing derived values:

```ts
  const reasoningEnabled = selectedManagedLlamaPreset.Reasoning === 'on';
  const reasoningContentEnabled = reasoningEnabled && selectedManagedLlamaPreset.ReasoningContent;
```

Update the `Reasoning` select handler so enabling reasoning defaults this setting to `true` and disabling reasoning clears it:

```tsx
onChange={(event) => updateManagedLlamaDraft((preset) => {
  preset.Reasoning = event.target.value as 'on' | 'off';
  if (preset.Reasoning !== 'on') {
    preset.ReasoningContent = false;
    preset.PreserveThinking = false;
    preset.MaintainPerStepThinking = false;
  } else {
    preset.MaintainPerStepThinking = true;
  }
})}
```

Do not change `MaintainPerStepThinking` when `ReasoningContent` is toggled off. It is tied to thinking being enabled, not to llama.cpp exposing `reasoning_content`.

Add the control after `Preserve thinking`:

```tsx
      {reasoningEnabled ? renderField('model-presets', 'Maintain per step thinking', (
        <label className="settings-live-toggle-control">
          <input
            type="checkbox"
            checked={selectedManagedLlamaPreset.MaintainPerStepThinking}
            onChange={(event) => updateManagedLlamaDraft((preset) => { preset.MaintainPerStepThinking = event.target.checked; })}
          />
          <span>{selectedManagedLlamaPreset.MaintainPerStepThinking ? 'Enabled' : 'Disabled'}</span>
        </label>
      )) : null}
```

- [ ] **Step 6: Re-run dashboard component test**

Run:

```powershell
npm test -- tab-components
```

Expected:

- PASS.

---

### Task 3: Add Expand Reads General Setting

**Files:**
- Modify: `dashboard/src/types.ts`
- Modify: `dashboard/src/types.d.ts`
- Modify: `dashboard/src/settings-sections.ts`
- Modify: `dashboard/src/tabs/SettingsTab.tsx`
- Test: `dashboard/tests/tab-components.test.tsx`

- [ ] **Step 1: Write failing General page render test**

In `dashboard/tests/tab-components.test.tsx`, update `DASHBOARD_CONFIG` or the full config fixture used by SettingsTab tests to include:

```ts
ExpandReads: true,
```

Extend the existing SettingsTab render test near the assertions for `Prompt prefix`, `AGENTS.md`, and `Initial repo file scan`:

```ts
assert.match(markup, /Expand reads/);
```

Add a direct General page toggle test:

```ts
test('settings tab general section renders Expand reads toggle', () => {
  const markup = renderToStaticMarkup(
    <SettingsTab
      activeSettingsSection="general"
      dashboardConfig={{
        ...DASHBOARD_CONFIG,
        ExpandReads: false,
      }}
      selectedSettingsPreset={PRESET}
      selectedManagedLlamaPreset={MANAGED_PRESET}
      selectedSettingsPresetId={PRESET.id}
      webSearchUsage={null}
      webSearchQuota={null}
      settingsLoading={false}
      settingsError={null}
      settingsDirty={false}
      settingsSavedAtUtc={null}
      settingsActionBusy={false}
      settingsRestartSupported={true}
      settingsSaving={false}
      settingsRestarting={false}
      settingsPathPickerBusyTarget={null}
      setSelectedSettingsPresetId={() => {}}
      requestSettingsAction={() => {}}
      updateSettingsDraft={() => {}}
      updatePresetDraft={() => {}}
      updateManagedLlamaDraft={() => {}}
      onAddPreset={() => {}}
      onDeletePreset={() => {}}
      onAddManagedLlamaPreset={() => {}}
      onDeleteManagedLlamaPreset={() => {}}
      onPickManagedLlamaPath={async () => {}}
      onTestLlamaCppBaseUrl={async () => {}}
      onReloadDashboardSettings={async () => {}}
      restartDashboardBackendCore={async () => true}
      onSaveDashboardSettings={async () => {}}
    />,
  );

  assert.match(markup, /Expand reads/);
  assert.match(markup, /Disabled/);
});
```

- [ ] **Step 2: Run dashboard component test and verify failure**

Run:

```powershell
npm test -- tab-components
```

Expected:

- The render assertion fails because the General page does not include `Expand reads`.

- [ ] **Step 3: Add dashboard/API type field**

If `dashboard/src/types.d.ts` directly declares the dashboard config shape, add:

```ts
  ExpandReads: boolean;
```

No edit is needed in `dashboard/src/types.ts` if it only re-exports `DashboardConfig` from `src/config/types.ts`; after Task 1, the field flows through that type.

- [ ] **Step 4: Add settings help text**

In `dashboard/src/settings-sections.ts`, add this General field after `Initial repo file scan`:

```ts
      { label: 'Expand reads', layout: 'half', helpText: 'When enabled, repeated narrow file reads can be expanded before execution. When disabled, SiftKit runs the requested read window unchanged while still tracking overlap.' },
```

- [ ] **Step 5: Add the General page toggle**

In `dashboard/src/tabs/SettingsTab.tsx`, add the field after `Initial repo file scan` and before `Prompt prefix`:

```tsx
        {renderField('general', 'Expand reads', (
          <label className="settings-live-toggle-control">
            <input
              type="checkbox"
              checked={dashboardConfig.ExpandReads}
              onChange={(event) => updateSettingsDraft((next) => { next.ExpandReads = event.target.checked; })}
            />
            <span>{dashboardConfig.ExpandReads ? 'Enabled' : 'Disabled'}</span>
          </label>
        ))}
```

- [ ] **Step 6: Re-run dashboard component test**

Run:

```powershell
npm test -- tab-components
```

Expected:

- PASS.

---

### Task 4: Add Shared Thinking Retention Policy

**Files:**
- Create: `src/thinking-retention-policy.ts`
- Test: `tests/status-server-chat.test.ts`
- Test: `tests/repo-search-chat-loop.test.ts`

- [ ] **Step 1: Write failing unit tests for persisted transcript pruning**

In `tests/status-server-chat.test.ts`, add:

```ts
test('appendChatMessagesWithUsage keeps only latest thinking in transcript when per-step thinking is disabled', () => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'siftkit-chat-last-thinking-'));
  const session = {
    ...createSession(),
    messages: [
      ...createSession().messages,
      { id: 'old-think', role: 'assistant', kind: 'assistant_thinking', content: 'old reasoning' },
      { id: 'old-answer', role: 'assistant', kind: 'assistant_answer', content: 'old answer' },
    ],
  } as ChatSession;

  const updated = appendChatMessagesWithUsage(
    runtimeRoot,
    session,
    'next',
    'answer',
    { promptTokens: 5, completionTokens: 2, thinkingTokens: 1, promptCacheTokens: null, promptEvalTokens: 5 },
    {
      maintainPerStepThinking: false,
      turns: [
        { thinkingText: 'tool think', toolMessages: [] },
        { thinkingText: 'final think', toolMessages: [] },
      ],
    },
  );

  const thinkingMessages = updated.messages.filter((message) => message.kind === 'assistant_thinking');
  assert.equal(thinkingMessages.length, 1);
  assert.equal(thinkingMessages[0]?.content, 'final think');
  assert.equal(updated.messages.some((message) => message.id === 'old-answer'), true);
});
```

Also update existing `appendChatMessagesWithUsage` calls in this file to pass:

```ts
maintainPerStepThinking: true,
```

inside the options object whenever the test expects multiple thinking messages to remain.

- [ ] **Step 2: Run status-server chat test and verify failure**

Run:

```powershell
npm test -- status-server-chat
```

Expected:

- Type failure because `AppendChatOptions` does not require `maintainPerStepThinking`.
- Assertion failure because old thinking is not pruned.

- [ ] **Step 3: Create the policy class**

Create `src/thinking-retention-policy.ts`:

```ts
import type { ChatMessage as PlannerChatMessage } from './repo-search/planner-protocol.js';
import type { ChatMessage as SessionChatMessage } from './state/chat-sessions.js';

export class ThinkingRetentionPolicy {
  private readonly maintainPerStepThinking: boolean;

  constructor(maintainPerStepThinking: boolean) {
    this.maintainPerStepThinking = maintainPerStepThinking;
  }

  pruneSessionMessages(messages: SessionChatMessage[]): SessionChatMessage[] {
    if (this.maintainPerStepThinking) {
      return messages;
    }
    const latestThinkingIndex = this.findLatestSessionThinkingIndex(messages);
    if (latestThinkingIndex < 0) {
      return messages;
    }
    return messages.filter((message, index) => {
      return message.kind !== 'assistant_thinking' || index === latestThinkingIndex;
    });
  }

  prunePlannerMessages(messages: PlannerChatMessage[]): void {
    if (this.maintainPerStepThinking) {
      return;
    }
    const latestThinkingIndex = this.findLatestPlannerThinkingIndex(messages);
    if (latestThinkingIndex < 0) {
      return;
    }
    for (let index = 0; index < messages.length; index += 1) {
      if (index !== latestThinkingIndex && typeof messages[index]?.reasoning_content === 'string') {
        delete messages[index].reasoning_content;
      }
    }
  }

  recordTurnThinking(turnThinking: Record<number, string>, turn: number, thinkingText: string): void {
    if (!thinkingText.trim()) {
      return;
    }
    if (!this.maintainPerStepThinking) {
      for (const key of Object.keys(turnThinking)) {
        delete turnThinking[Number(key)];
      }
    }
    turnThinking[turn] = thinkingText;
  }

  private findLatestSessionThinkingIndex(messages: SessionChatMessage[]): number {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      if (messages[index]?.kind === 'assistant_thinking') {
        return index;
      }
    }
    return -1;
  }

  private findLatestPlannerThinkingIndex(messages: PlannerChatMessage[]): number {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      if (typeof messages[index]?.reasoning_content === 'string' && messages[index].reasoning_content.trim()) {
        return index;
      }
    }
    return -1;
  }
}
```

- [ ] **Step 4: Use the policy in chat persistence**

In `src/status-server/chat.ts`, update `AppendChatOptions`:

```ts
type AppendChatOptions = {
  turns: PersistTurn[];
  maintainPerStepThinking: boolean;
  inputTokens?: number | null;
  inputTokensEstimated?: boolean;
  requestDurationMs?: number | null;
  promptEvalDurationMs?: number | null;
  generationDurationMs?: number | null;
  promptTokensPerSecond?: number | null;
  generationTokensPerSecond?: number | null;
  answerStartedAtUtc?: string | null;
  answerEndedAtUtc?: string | null;
  speculativeAcceptedTokens?: number | null;
  speculativeGeneratedTokens?: number | null;
  outputTokens?: number | null;
  outputTokensEstimated?: boolean;
  thinkingTokens?: number | null;
  thinkingTokensEstimated?: boolean;
  sourceRunId?: string | null;
  groundingStatus?: ChatGroundingStatus | null;
};
```

Remove the default `{ turns: [] }` from `appendChatMessagesWithUsage` so all call sites must pass the policy explicitly:

```ts
export function appendChatMessagesWithUsage(
  runtimeRoot: string,
  session: ChatSession,
  content: string,
  assistantContent: string,
  usage: Partial<ChatUsage>,
  options: AppendChatOptions,
): ChatSession {
```

After all new messages are appended and before returning the session, apply:

```ts
  const retainedMessages = new ThinkingRetentionPolicy(options.maintainPerStepThinking)
    .pruneSessionMessages(messages as ChatMessage[]);
```

Then return the session with `messages: retainedMessages`.

- [ ] **Step 5: Re-run status-server chat tests**

Run:

```powershell
npm test -- status-server-chat
```

Expected:

- Remaining failures identify route call sites that still omit `maintainPerStepThinking`.

---

### Task 5: Resolve Setting In Routes And Persist WYSIWYG Sessions

**Files:**
- Modify: `src/status-server/routes/chat.ts`
- Modify: `src/status-server/chat.ts`
- Test: `tests/dashboard-status-server.test.ts`
- Test: `tests/status-server-chat.test.ts`

- [ ] **Step 1: Add explicit config helper in `chat.ts`**

Add this exported helper in `src/status-server/chat.ts` near `shouldPreserveThinking`:

```ts
export function shouldMaintainPerStepThinking(config: Dict, thinkingEnabled: boolean): boolean {
  if (!thinkingEnabled) {
    return false;
  }
  const server = config.Server && typeof config.Server === 'object' ? config.Server as Dict : null;
  const serverLlama = server?.LlamaCpp && typeof server.LlamaCpp === 'object' ? server.LlamaCpp as Dict : null;
  const presets = Array.isArray(serverLlama?.Presets) ? serverLlama.Presets as Dict[] : [];
  const activePresetId = typeof serverLlama?.ActivePresetId === 'string' ? serverLlama.ActivePresetId : '';
  const activePreset = presets.find((preset) => preset.id === activePresetId) || presets[0] || null;
  return activePreset?.MaintainPerStepThinking !== false;
}
```

This intentionally reads the normalized managed preset shape and does not add a flat legacy fallback.

- [ ] **Step 2: Update all append call sites**

In `src/status-server/routes/chat.ts`, each `appendChatMessagesWithUsage` call must pass:

```ts
maintainPerStepThinking: shouldMaintainPerStepThinking(config as Dict, activeSession.thinkingEnabled !== false),
```

For call sites that construct a modified session object inline, keep the `thinkingEnabled` check tied to that session object:

```ts
const sessionForPersistence = {
  ...activeSession,
  presetId: preset?.id || activeSession.presetId || 'repo-search',
  mode: 'repo-search',
  planRepoRoot: resolvedRepoRoot,
};

const updatedSession = appendChatMessagesWithUsage(
  runtimeRoot,
  sessionForPersistence,
  content,
  assistantContent,
  usage,
  {
    maintainPerStepThinking: shouldMaintainPerStepThinking(config as Dict, sessionForPersistence.thinkingEnabled !== false),
    turns: await countPersistTurnThinkingTokens(config, buildPersistTurnsFromRepoSearchResult(result).map((turn) => ({
      thinkingText: turn.thinkingText,
      toolMessages: turn.toolMessages.map((message) => ({
        ...message,
        toolCallPromptTokenCount: getScorecardTotal(result?.scorecard, 'promptTokens'),
      })),
    }))),
    inputTokens: inputTokenCount.tokenCount,
    inputTokensEstimated: inputTokenCount.estimated,
    requestDurationMs: Date.now() - startedAt,
    promptEvalDurationMs: getScorecardTotal(result?.scorecard, 'promptEvalDurationMs'),
    generationDurationMs: getScorecardTotal(result?.scorecard, 'generationDurationMs'),
  },
);
```

- [ ] **Step 3: Update route tests/fixtures**

Any test fixture config used with route persistence must use normalized managed preset shape:

```ts
Server: {
  LlamaCpp: {
    Presets: [{
      id: 'default',
      label: 'Default',
      Reasoning: 'on',
      ReasoningContent: true,
      PreserveThinking: true,
      MaintainPerStepThinking: false,
    }],
    ActivePresetId: 'default',
  },
},
```

- [ ] **Step 4: Re-run route and chat tests**

Run:

```powershell
npm test -- status-server-chat
npm test -- dashboard-status-server
```

Expected:

- PASS.

---

### Task 6: Replay Retained Thinking Into Model Context

**Files:**
- Modify: `src/status-server/chat.ts`
- Test: `tests/status-server-chat.test.ts`

- [ ] **Step 1: Write failing replay tests**

Add tests:

```ts
test('buildChatHistoryMessages replays all retained thinking when preserve thinking is enabled', () => {
  const session = {
    id: 's1',
    thinkingEnabled: true,
    messages: [
      { id: 'u1', role: 'user', kind: 'user_text', content: 'Question' },
      { id: 'think-1', role: 'assistant', kind: 'assistant_thinking', content: 'first reasoning' },
      { id: 'a1', role: 'assistant', kind: 'assistant_answer', content: 'First answer' },
      { id: 'think-2', role: 'assistant', kind: 'assistant_thinking', content: 'second reasoning' },
      {
        id: 'tool-1',
        role: 'assistant',
        kind: 'assistant_tool_call',
        content: 'rg -n "x" src',
        toolCallCommand: 'rg -n "x" src',
        toolCallOutput: 'src/x.ts:1:x',
      },
    ],
  };

  assert.deepEqual(buildChatHistoryMessages(createConfig(), session as never), [
    { role: 'user', content: 'Question' },
    { role: 'assistant', content: 'First answer', reasoning_content: 'first reasoning' },
    {
      role: 'assistant',
      content: '',
      reasoning_content: 'second reasoning',
      tool_calls: [{
        id: 'chat_tool_tool-1',
        type: 'function',
        function: {
          name: 'persisted_tool_call',
          arguments: JSON.stringify({ command: 'rg -n "x" src' }),
        },
      }],
    },
    {
      role: 'tool',
      tool_call_id: 'chat_tool_tool-1',
      content: 'src/x.ts:1:x',
    },
  ]);
});

test('buildChatHistoryMessages omits retained thinking when preserve thinking is disabled', () => {
  const config = createConfig({
    Server: {
      LlamaCpp: {
        Presets: [{
          id: 'default',
          label: 'Default',
          Reasoning: 'on',
          ReasoningContent: true,
          PreserveThinking: false,
          MaintainPerStepThinking: true,
        }],
        ActivePresetId: 'default',
      },
    },
  });
  const session = {
    id: 's1',
    thinkingEnabled: true,
    messages: [
      { id: 'think-1', role: 'assistant', kind: 'assistant_thinking', content: 'first reasoning' },
      { id: 'a1', role: 'assistant', kind: 'assistant_answer', content: 'First answer' },
    ],
  };

  assert.deepEqual(buildChatHistoryMessages(config, session as never), [
    { role: 'assistant', content: 'First answer' },
  ]);
});
```

- [ ] **Step 2: Run replay tests and verify failure**

Run:

```powershell
npm test -- status-server-chat
```

Expected:

- Existing implementation skips `assistant_thinking`.

- [ ] **Step 3: Update replay builder**

In `buildChatHistoryMessages`, replace the unconditional skip with pending-thinking handling:

```ts
  const replayThinking = shouldPreserveThinking(_config, session.thinkingEnabled !== false);
  let pendingThinking = '';
```

When an `assistant_thinking` message is encountered:

```ts
    if (kind === 'assistant_thinking') {
      if (replayThinking) {
        pendingThinking = getTrimmedString(message.content);
      }
      continue;
    }
```

When appending an assistant answer:

```ts
    if (message.role === 'assistant') {
      history.push({
        role: 'assistant',
        content,
        ...(pendingThinking ? { reasoning_content: pendingThinking } : {}),
      });
      pendingThinking = '';
      continue;
    }
```

Update `appendReplayToolMessages` to accept `reasoningContent: string` and attach it to the assistant tool-call replay message:

```ts
function appendReplayToolMessages(history: ChatMessage[], message: Dict, reasoningContent: string): void {
  const toolCallId = `chat_tool_${String(message.id || crypto.randomUUID())}`;
  history.push({
    role: 'assistant',
    content: '',
    ...(reasoningContent ? { reasoning_content: reasoningContent } : {}),
    tool_calls: [{
      id: toolCallId,
      type: 'function',
      function: {
        name: 'persisted_tool_call',
        arguments: JSON.stringify({ command }),
      },
    }],
  });
  history.push({
    role: 'tool',
    tool_call_id: toolCallId,
    content: output,
  });
}
```

Call it as:

```ts
      appendReplayToolMessages(history, message, pendingThinking);
      pendingThinking = '';
```

After the loop, if `pendingThinking` remains:

```ts
  if (pendingThinking) {
    history.push({ role: 'assistant', content: '', reasoning_content: pendingThinking });
  }
```

- [ ] **Step 4: Re-run replay tests**

Run:

```powershell
npm test -- status-server-chat
```

Expected:

- PASS.

---

### Task 7: Apply Retention Inside Repo-Search/Tool-Call Loops

**Files:**
- Modify: `src/repo-search/engine/task-loop-support.ts`
- Modify: `src/repo-search/engine/task-loop.ts`
- Modify: `src/repo-search/engine/transcript-manager.ts`
- Test: `tests/repo-search-chat-loop.test.ts`

- [ ] **Step 1: Write failing repo-search loop tests**

Add a test that proves prior tool-call thinking is removed from later planner context when the setting is off:

```ts
test('repo-search loop drops prior tool-call thinking from planner transcript when per-step thinking is disabled', async () => {
  const requestMessages: Array<Array<{ role: string; reasoning_content?: string }>> = [];

  await runRepoSearch(
    'find evidence',
    {
      baseUrl: 'http://127.0.0.1:1',
      model: 'mock',
      repoRoot: process.cwd(),
      loopKind: 'repo-search',
      maxTurns: 3,
      includeRepoFileListing: false,
      config: {
        Server: {
          LlamaCpp: {
            Presets: [{
              id: 'default',
              label: 'Default',
              Reasoning: 'on',
              ReasoningContent: true,
              PreserveThinking: true,
              MaintainPerStepThinking: false,
            }],
            ActivePresetId: 'default',
          },
        },
        Runtime: {
          Model: 'mock',
          LlamaCpp: { BaseUrl: 'http://127.0.0.1:1', NumCtx: 32000, Reasoning: 'on' },
        },
      } as SiftConfig,
      mockResponses: [
        '{"action":"repo_search","query":"first"}',
        '{"action":"repo_search","query":"second"}',
        '{"action":"finish","output":"done"}',
      ],
      mockResponseThinking: ['think one', 'think two', 'think three'],
      mockCommandResults: {
        repo_search: 'src/a.ts:1:first\nsrc/b.ts:2:second',
      },
      logger: {
        path: '',
        write: (event) => {
          if (event.kind === 'planner_request') {
            requestMessages.push(event.messages as Array<{ role: string; reasoning_content?: string }>);
          }
        },
      },
    },
  );

  const latestRequest = requestMessages[requestMessages.length - 1] || [];
  const reasoningMessages = latestRequest.filter((message) => typeof message.reasoning_content === 'string' && message.reasoning_content.trim());
  assert.equal(reasoningMessages.length, 1);
  assert.equal(reasoningMessages[0]?.reasoning_content, 'think two');
});
```

If the current logger does not emit `planner_request` messages, add a focused `TranscriptManager` test instead:

```ts
test('TranscriptManager removes older reasoning content when per-step thinking is disabled', () => {
  const manager = new TranscriptManager([
    { role: 'user', content: 'Question' },
  ]);

  manager.appendToolExchange({ action: 'repo_search', query: 'one' }, 'tool-1', 'one result', 'think one');
  manager.pruneThinking(false);
  manager.appendToolExchange({ action: 'repo_search', query: 'two' }, 'tool-2', 'two result', 'think two');
  manager.pruneThinking(false);

  const reasoningMessages = manager.getMessages().filter((message) => typeof message.reasoning_content === 'string' && message.reasoning_content.trim());
  assert.equal(reasoningMessages.length, 1);
  assert.equal(reasoningMessages[0]?.reasoning_content, 'think two');
});
```

- [ ] **Step 2: Run repo-search tests and verify failure**

Run:

```powershell
npm test -- repo-search-chat-loop
```

Expected:

- Prior `reasoning_content` remains because no retention policy is applied to the active planner transcript.

- [ ] **Step 3: Add planner config helper**

In `src/repo-search/engine/task-loop-support.ts`, add:

```ts
export function isPlannerMaintainPerStepThinkingEnabled(config: SiftConfig | undefined): boolean {
  if (!isPlannerReasoningEnabled(config)) {
    return false;
  }
  const activePreset = config ? getActiveManagedLlamaPreset(config) : null;
  return activePreset?.MaintainPerStepThinking !== false;
}
```

- [ ] **Step 4: Add transcript manager pruning**

In `src/repo-search/engine/transcript-manager.ts`, import:

```ts
import { ThinkingRetentionPolicy } from '../../thinking-retention-policy.js';
```

Add:

```ts
  pruneThinking(maintainPerStepThinking: boolean): void {
    new ThinkingRetentionPolicy(maintainPerStepThinking).prunePlannerMessages(this.messages);
  }
```

- [ ] **Step 5: Apply policy in `RunTaskLoop`**

In `src/repo-search/engine/task-loop.ts`, add a field:

```ts
  private readonly plannerMaintainPerStepThinking: boolean;
```

Import the helper:

```ts
  isPlannerMaintainPerStepThinkingEnabled,
```

Set it in the constructor after `plannerPreserveThinkingEnabled`:

```ts
    this.plannerMaintainPerStepThinking = this.plannerThinkingEnabled
      && isPlannerMaintainPerStepThinkingEnabled(options.config);
```

When recording thinking, replace direct assignment:

```ts
    if (turnThinkingText) {
      new ThinkingRetentionPolicy(this.plannerMaintainPerStepThinking)
        .recordTurnThinking(this.turnThinking, turn, turnThinkingText);
    }
```

After every transcript append that can include reasoning, prune explicitly:

```ts
      this.transcript.appendToolExchange(action, toolCallId, toolContent, turnThinkingText);
      this.transcript.pruneThinking(this.plannerMaintainPerStepThinking);
```

```ts
      this.transcript.appendBatchExchange(batchOutcomes, turnThinkingText);
      this.transcript.pruneThinking(this.plannerMaintainPerStepThinking);
```

```ts
      this.transcript.pushAssistant(buildAssistantReplayMessage(response.text, String(response.thinkingText || '').trim()));
      this.transcript.pruneThinking(this.plannerMaintainPerStepThinking);
```

- [ ] **Step 6: Re-run repo-search tests**

Run:

```powershell
npm test -- repo-search-chat-loop
```

Expected:

- PASS.

---

### Task 8: Apply WYSIWYG Retention To Live Streaming UI

**Files:**
- Modify: `dashboard/src/lib/live-thinking-message.ts`
- Modify: `dashboard/src/hooks/useLiveMessages.ts`
- Modify: `dashboard/src/hooks/useChatComposer.ts`
- Modify: `dashboard/src/App.tsx`
- Test: `dashboard/tests/live-thinking-message.test.ts`

- [ ] **Step 1: Write failing live thinking test**

In `dashboard/tests/live-thinking-message.test.ts`, add:

```ts
test('appendLiveThinkingMessage keeps only latest thinking segment when per-step thinking is disabled', () => {
  const first = appendLiveThinkingMessage([], 'a', false);
  const withTool = [...first, makeToolMessage('live-tool-1')];
  const second = appendLiveThinkingMessage(withTool, 'b', false);
  const withSecondTool = [...second, makeToolMessage('live-tool-2')];
  const third = appendLiveThinkingMessage(withSecondTool, 'c', false);

  const thinkingMessages = third.filter((entry) => entry.kind === 'assistant_thinking');
  assert.equal(thinkingMessages.length, 1);
  assert.equal(thinkingMessages[0]?.content, 'c');
  assert.equal(third.some((entry) => entry.id === 'live-tool-1'), true);
  assert.equal(third.some((entry) => entry.id === 'live-tool-2'), true);
});
```

Update existing calls to pass `true` where tests expect the current multi-thinking behavior:

```ts
appendLiveThinkingMessage(previous, text, true)
```

- [ ] **Step 2: Run live thinking test and verify failure**

Run:

```powershell
npm test -- live-thinking-message
```

Expected:

- Type failures because `appendLiveThinkingMessage` does not accept the policy.

- [ ] **Step 3: Update live thinking helper**

Change signature:

```ts
export function appendLiveThinkingMessage(
  messages: ChatMessage[],
  thinkingText: string,
  maintainPerStepThinking: boolean,
): ChatMessage[] {
```

Before returning, prune older live thinking when disabled:

```ts
  const nextMessages = appendOrExtendLiveThinking(messages, thinkingText);
  if (maintainPerStepThinking) {
    return nextMessages;
  }
  const latestThinkingIndex = nextMessages.findLastIndex((message) => message.kind === 'assistant_thinking');
  return nextMessages.filter((message, index) => {
    return message.kind !== 'assistant_thinking' || index === latestThinkingIndex;
  });
}
```

If the project target does not support `findLastIndex`, use an explicit reverse loop:

```ts
function findLatestThinkingIndex(messages: ChatMessage[]): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.kind === 'assistant_thinking') {
      return index;
    }
  }
  return -1;
}
```

- [ ] **Step 4: Thread policy through dashboard hooks**

In `dashboard/src/hooks/useLiveMessages.ts`, change:

```ts
    appendLiveThinking(text: string, maintainPerStepThinking: boolean): void {
      setLiveMessages((previous) => appendLiveThinkingMessage(previous, text, maintainPerStepThinking));
    },
```

Update the result type accordingly.

In `dashboard/src/hooks/useChatComposer.ts`, add a dependency:

```ts
  maintainPerStepThinkingForCurrentPreset: boolean;
```

Where streaming callbacks currently call:

```ts
live.appendLiveThinking(thinkingText);
```

change to:

```ts
live.appendLiveThinking(thinkingText, deps.maintainPerStepThinkingForCurrentPreset);
```

In `dashboard/src/App.tsx`, derive:

```ts
  const maintainPerStepThinkingForCurrentPreset = selectedManagedLlamaPreset?.Reasoning === 'on'
    ? selectedManagedLlamaPreset.MaintainPerStepThinking !== false
    : false;
```

Pass it to `useChatComposer`.

- [ ] **Step 5: Re-run live/dashboard tests**

Run:

```powershell
npm test -- live-thinking-message
npm test -- tab-components
```

Expected:

- PASS.

---

### Task 9: Add Expand Reads Runtime Gate

**Files:**
- Modify: `src/repo-search/engine/read-window-governor.ts`
- Modify: `src/repo-search/engine/tool-action-processor.ts`
- Modify: `src/repo-search/engine/task-loop.ts`
- Test: `tests/engine-read-window-governor.test.ts`
- Test: `tests/repo-search-chat-loop.test.ts`

- [ ] **Step 1: Write failing read governor test**

In `tests/engine-read-window-governor.test.ts`, add:

```ts
test('planAdjustment does not expand narrow reads when expandReads is disabled', () => {
  const governor = new ReadWindowGovernor();
  const firstMetrics = governor.recordExecution({
    parsedReadWindow: window(1, 100),
    executedReadWindow: window(1, 100),
    turn: 1,
    adjusted: false,
  });
  governor.applyFitTruncation({
    parsedReadWindow: window(1, 100),
    executedReadWindow: window(1, 100),
    fittedReturnedSegmentCount: null,
    metrics: firstMetrics,
  });

  const planned = governor.planAdjustment({
    parsedReadWindow: window(1, 50),
    perToolCapTokens: 1000,
    currentGetContentStats: null,
    historicalGetContentStats: null,
    expandReads: false,
  });

  assert.equal(planned, null);
  const secondMetrics = governor.recordExecution({
    parsedReadWindow: window(1, 50),
    executedReadWindow: window(1, 50),
    turn: 2,
    adjusted: false,
  });
  assert.equal(secondMetrics.overlapLines > 0, true);
});
```

Update existing `planAdjustment` calls in `tests/engine-read-window-governor.test.ts` to pass:

```ts
expandReads: true,
```

- [ ] **Step 2: Run read governor test and verify failure**

Run:

```powershell
npm test -- engine-read-window-governor
```

Expected:

- Type failures because `planAdjustment` does not accept `expandReads`.

- [ ] **Step 3: Add explicit `expandReads` option to the governor**

In `src/repo-search/engine/read-window-governor.ts`, update the option type inline:

```ts
  planAdjustment(options: {
    parsedReadWindow: ParsedGetContentReadWindow;
    perToolCapTokens: number;
    currentGetContentStats: ToolTypeStats | null;
    historicalGetContentStats: ToolTypeStats | null;
    expandReads: boolean;
  }): PlannedReadAdjustment | null {
```

After the existing previous-read guard, add:

```ts
    if (!options.expandReads) {
      return null;
    }
```

Keep `recordExecution`, `applyFitTruncation`, returned-range merging, and overlap summaries unchanged.

- [ ] **Step 4: Thread `ExpandReads` through repo-search runtime**

In `src/repo-search/engine/tool-action-processor.ts`, extend `ToolActionProcessorDeps`:

```ts
  expandReads: boolean;
```

In the `planAdjustment` call, pass:

```ts
        expandReads: this.deps.expandReads,
```

In `src/repo-search/engine/task-loop.ts`, add a readonly field:

```ts
  private readonly expandReads: boolean;
```

Set it in the constructor after config-derived fields:

```ts
    this.expandReads = options.config?.ExpandReads !== false;
```

When constructing `ToolActionProcessor`, pass:

```ts
      expandReads: this.expandReads,
```

- [ ] **Step 5: Write and run repo-search integration test**

In `tests/repo-search-chat-loop.test.ts`, add a focused test that configures `ExpandReads: false`, performs two overlapping `Get-Content` reads, and asserts the second command logged in `commands` remains the requested narrow command rather than an expanded/shifted command.

Use this assertion shape:

```ts
assert.equal(result.scorecard.tasks[0].commands[1].command.includes('-First 50'), true);
assert.equal(result.scorecard.tasks[0].commands[1].command.includes('-Skip 0'), true);
```

Run:

```powershell
npm test -- repo-search-chat-loop
```

Expected:

- PASS after `ExpandReads` is threaded into `ToolActionProcessor`.

- [ ] **Step 6: Re-run read governor test**

Run:

```powershell
npm test -- engine-read-window-governor
```

Expected:

- PASS.

---

### Task 10: Update Prompt Dispatch Documentation

**Files:**
- Modify: `docs/prompt-dispatch-inventory.md`

- [ ] **Step 1: Update reasoning controls section**

In `docs/prompt-dispatch-inventory.md`, update section `4.3 Reasoning/thinking controls` to state:

```md
- `enable_thinking` turns llama.cpp thinking generation on/off.
- `reasoning_content` asks llama.cpp to expose thinking as structured `reasoning_content`.
- `preserve_thinking` asks llama.cpp to preserve included `reasoning_content` while rendering the prompt.
- `MaintainPerStepThinking` is SiftKit-side transcript retention:
  - `true`: keep all visible/persisted thinking blocks.
  - `false`: keep only the latest visible/persisted thinking block and remove earlier thinking from active planner replay.
- `ExpandReads` is SiftKit-side read execution policy:
  - `true`: repeated narrow reads can be expanded or shifted before execution.
  - `false`: requested read windows run unchanged, while overlap accounting remains enabled.
```

- [ ] **Step 2: Verify docs mention all five settings**

Run:

```powershell
rg -n "enable_thinking|reasoning_content|preserve_thinking|MaintainPerStepThinking|ExpandReads" docs/prompt-dispatch-inventory.md
```

Expected:

- All five identifiers are present in the reasoning/thinking controls section or adjacent read execution policy section.

---

### Task 11: Final Validation

**Files:**
- All modified files from prior tasks.

- [ ] **Step 1: Run targeted tests**

Run:

```powershell
npm test -- status-server-chat
npm test -- repo-search-chat-loop
npm test -- engine-read-window-governor
npm test -- live-thinking-message
npm test -- tab-components
npm test -- dashboard-managed-presets
npm test -- dashboard-presets
npm test -- settings-runtime
```

Expected:

- PASS for each command.

- [ ] **Step 2: Run typecheck**

Run:

```powershell
npm run typecheck
```

Expected:

- PASS with no TypeScript errors.

- [ ] **Step 3: Run full test suite**

Run:

```powershell
npm test
```

Expected:

- PASS.

- [ ] **Step 4: Inspect diff for scope**

Run:

```powershell
git -C . diff --stat
git -C . diff -- src/config/types.ts src/config/defaults.ts src/config/normalization.ts src/thinking-retention-policy.ts src/status-server/chat.ts src/status-server/routes/chat.ts src/repo-search/engine/task-loop.ts src/repo-search/engine/task-loop-support.ts src/repo-search/engine/transcript-manager.ts src/repo-search/engine/read-window-governor.ts src/repo-search/engine/tool-action-processor.ts dashboard/src/tabs/settings/ManagedLlamaSection.tsx dashboard/src/tabs/SettingsTab.tsx dashboard/src/settings-sections.ts dashboard/src/lib/live-thinking-message.ts dashboard/src/hooks/useLiveMessages.ts dashboard/src/hooks/useChatComposer.ts dashboard/src/App.tsx docs/prompt-dispatch-inventory.md
```

Expected:

- Diff only covers first-class `MaintainPerStepThinking` config, first-class `ExpandReads` config, WYSIWYG transcript retention, read expansion gating, replay behavior, UI controls, docs, and tests.
- No legacy fallback paths.
- No unrelated refactors.

---

## Self-Review

- Requirements covered:
  - `MaintainPerStepThinking` boolean setting exists: Task 1 and Task 2.
  - Default true when thinking is on: Task 1 normalization and Task 2 UI enable behavior.
  - False keeps only latest thinking block: Task 4, Task 7, Task 8.
  - True keeps all thinking blocks: Task 4, Task 6, Task 7.
  - Applies to repo-search/tool-call loops: Task 7.
  - Dropped means deleted from visible/persisted transcript, not only replay: Task 4 and Task 8.
  - `ExpandReads` setting exists on the General page: Task 1 and Task 3.
  - `ExpandReads=false` disables narrow-read expansion without disabling overlap logic: Task 9.
- Placeholder scan:
  - No unresolved implementation placeholders.
- Type consistency:
  - Config field name is consistently `MaintainPerStepThinking`.
  - Config field name is consistently `ExpandReads`.
  - Runtime boolean names are consistently `maintainPerStepThinking`.
  - Runtime boolean names are consistently `expandReads`.
  - Existing llama.cpp fields remain `enable_thinking`, `reasoning_content`, and `preserve_thinking`.

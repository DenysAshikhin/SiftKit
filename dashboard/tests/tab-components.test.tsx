import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactElement, ReactNode } from 'react';

import { MetricsTab } from '../src/tabs/MetricsTab';
import { SettingsTab } from '../src/tabs/SettingsTab';
import { ChatTab } from '../src/tabs/ChatTab';
import { PresetsSection } from '../src/tabs/settings/PresetsSection';
import { ManagedLlamaSection } from '../src/tabs/settings/ManagedLlamaSection';
import { updateActiveManagedLlamaPreset } from '../src/managed-llama-presets';
import type {
  ChatMessage,
  ChatSession,
  ContextUsage,
  DashboardConfig,
  DashboardManagedLlamaPreset,
  DashboardPreset,
  IdleSummarySnapshot,
  MetricDay,
} from '../src/types';

const METRIC_DAY = {
  date: '2026-04-16',
  runs: 3,
  successCount: 2,
  failureCount: 1,
  inputTokens: 120,
  outputTokens: 45,
  thinkingTokens: 10,
  toolTokens: 4,
  promptCacheTokens: 20,
  promptEvalTokens: 40,
  cacheHitRate: 0.5,
  avgDurationMs: 1200,
} as MetricDay;

const IDLE_SNAPSHOT = {
  emittedAtUtc: '2026-04-16T12:00:00.000Z',
  completedRequestCount: 4,
  inputCharactersTotal: 10,
  outputCharactersTotal: 10,
  inputTokensTotal: 50,
  outputTokensTotal: 25,
  thinkingTokensTotal: 5,
  toolTokensTotal: 1,
  promptCacheTokensTotal: 0,
  promptEvalTokensTotal: 0,
  savedTokens: 3,
  savedPercent: 12,
  compressionRatio: 1.3,
  requestDurationMsTotal: 4000,
  avgRequestMs: 1000,
  avgTokensPerSecond: 8,
  summaryText: '',
} as IdleSummarySnapshot;

const MANAGED_PRESET = {
  id: 'managed',
  label: 'Managed',
  Model: 'test-model',
  ExecutablePath: null,
  BaseUrl: 'http://127.0.0.1:8080',
  BindHost: '127.0.0.1',
  Port: 8080,
  ModelPath: null,
  NumCtx: 4096,
  GpuLayers: 0,
  Threads: 4,
  NcpuMoe: 0,
  FlashAttention: false,
  ParallelSlots: 1,
  BatchSize: 512,
  UBatchSize: 512,
  CacheRam: 2048,
  KvCacheQuantization: 'f16',
  MaxTokens: 512,
  Temperature: 0.7,
  TopP: 0.9,
  TopK: 40,
  MinP: 0.05,
  PresencePenalty: 0,
  RepetitionPenalty: 1.1,
  Reasoning: 'auto',
  ReasoningBudget: 128,
  ReasoningBudgetMessage: '',
  StartupTimeoutMs: 1000,
  HealthcheckTimeoutMs: 1000,
  HealthcheckIntervalMs: 500,
  VerboseLogging: false,
} as DashboardManagedLlamaPreset;

const PRESET = {
  id: 'summary-default',
  label: 'Summary',
  description: 'Default summary preset',
  presetKind: 'summary',
  operationMode: 'summary',
  executionFamily: 'summary',
  promptPrefix: '',
  allowedTools: ['read_lines'],
  surfaces: ['cli', 'web'],
  useForSummary: true,
  builtin: true,
  deletable: false,
  includeAgentsMd: false,
  includeRepoFileListing: false,
  repoRootRequired: false,
  maxTurns: null,
  thinkingInterval: null,
  thinkingEnabled: null,
} as DashboardPreset;

const DASHBOARD_CONFIG = {
  Version: '1',
  Backend: 'llama.cpp',
  PolicyMode: 'conservative',
  RawLogRetention: true,
  PromptPrefix: '',
  OperationModeAllowedTools: {
    summary: ['read_lines'],
    'read-only': ['read_lines'],
    full: ['read_lines'],
  },
  Presets: [PRESET],
  LlamaCpp: {
    BaseUrl: 'http://127.0.0.1:8080',
    NumCtx: 4096,
    ModelPath: null,
    Temperature: 0.7,
    TopP: 0.9,
    TopK: 40,
    MinP: 0.05,
    PresencePenalty: 0,
    RepetitionPenalty: 1.1,
    MaxTokens: 512,
    GpuLayers: 0,
    Threads: 4,
    NcpuMoe: 0,
    FlashAttention: false,
    ParallelSlots: 1,
    Reasoning: 'auto',
  },
  Runtime: {
    Model: 'test-model',
    LlamaCpp: {
      BaseUrl: 'http://127.0.0.1:8080',
      NumCtx: 4096,
      ModelPath: null,
      Temperature: 0.7,
      TopP: 0.9,
      TopK: 40,
      MinP: 0.05,
      PresencePenalty: 0,
      RepetitionPenalty: 1.1,
      MaxTokens: 512,
      GpuLayers: 0,
      Threads: 4,
      NcpuMoe: 0,
      FlashAttention: false,
      ParallelSlots: 1,
      Reasoning: 'auto',
    },
  },
  Thresholds: {
    MinCharactersForSummary: 10,
    MinLinesForSummary: 2,
  },
  Interactive: {
    Enabled: true,
    WrappedCommands: ['npm test'],
    IdleTimeoutMs: 1000,
    MaxTranscriptCharacters: 2000,
    TranscriptRetention: true,
  },
  Server: {
    LlamaCpp: {
      Model: 'test-model',
      ...MANAGED_PRESET,
      Presets: [MANAGED_PRESET],
      ActivePresetId: MANAGED_PRESET.id,
    },
  },
} as DashboardConfig;

const CHAT_MESSAGE = {
  id: 'message-1',
  role: 'assistant',
  content: 'Hello from the assistant.',
  inputTokensEstimate: 12,
  outputTokensEstimate: 4,
  thinkingTokens: 0,
  associatedToolTokens: 0,
  thinkingContent: '',
  createdAtUtc: '2026-04-16T12:00:00.000Z',
  sourceRunId: null,
} as ChatMessage;

const CHAT_SESSION = {
  id: 'session-1',
  title: 'Session',
  model: 'test-model',
  contextWindowTokens: 100,
  thinkingEnabled: true,
  presetId: PRESET.id,
  mode: 'chat',
  condensedSummary: '',
  createdAtUtc: '2026-04-16T11:00:00.000Z',
  updatedAtUtc: '2026-04-16T12:00:00.000Z',
  messages: [CHAT_MESSAGE],
} as ChatSession;

const CONTEXT_USAGE = {
  shouldCondense: false,
  chatUsedTokens: 10,
  toolUsedTokens: 0,
  totalUsedTokens: 10,
  remainingTokens: 90,
  warnThresholdTokens: 50,
  contextWindowTokens: 100,
  usedTokens: 10,
  estimatedTokenFallbackTokens: 0,
} as ContextUsage;

type CapturedField = {
  label: string;
  children: ReactNode;
};

type InputElementProps = {
  children?: ReactNode;
  onChange?: (event: { target: { value: string } }) => void;
};

function findInputElement(node: ReactNode): ReactElement<InputElementProps> | null {
  if (Array.isArray(node)) {
    for (const child of node) {
      const match = findInputElement(child);
      if (match) {
        return match;
      }
    }

    return null;
  }

  if (!React.isValidElement<InputElementProps>(node)) {
    return null;
  }

  if (node.type === 'input') {
    return node;
  }

  return findInputElement(node.props.children ?? null);
}

test('metrics tab renders tool metrics and idle summary', () => {
  const markup = renderToStaticMarkup(
    <MetricsTab
      metrics={[METRIC_DAY]}
      idleSummarySnapshots={[IDLE_SNAPSHOT, IDLE_SNAPSHOT]}
      recentIdlePoints={[IDLE_SNAPSHOT]}
      latestIdleSnapshot={IDLE_SNAPSHOT}
      sortedToolMetricRows={[{
        taskKind: 'summary',
        toolType: 'read_lines',
        calls: 2,
        outputCharsTotal: 20,
        outputTokensTotal: 10,
        outputTokensEstimatedCount: 0,
        lineReadCalls: 1,
        lineReadLinesTotal: 5,
        lineReadTokensTotal: 10,
        finishRejections: 0,
        semanticRepeatRejects: 0,
        stagnationWarnings: 0,
        forcedFinishFromStagnation: 0,
        promptInsertedTokens: 0,
        rawToolResultTokens: 0,
        newEvidenceCalls: 1,
        noNewEvidenceCalls: 0,
        lineReadRecommendedLines: 5,
        lineReadAllowanceTokens: 20,
      }]}
      taskRunsGraphSeries={[]}
    />,
  );

  assert.match(markup, /Live Idle Summary/);
  assert.match(markup, /read_lines/);
});

test('settings tab renders section chrome and fields', () => {
  const markup = renderToStaticMarkup(
    <SettingsTab
      activeSettingsSection="general"
      dashboardConfig={DASHBOARD_CONFIG}
      selectedSettingsPreset={PRESET}
      selectedManagedLlamaPreset={MANAGED_PRESET}
      selectedSettingsPresetId={PRESET.id}
      settingsLoading={false}
      settingsError={null}
      settingsDirty={false}
      settingsSavedAtUtc="2026-04-16T12:00:00.000Z"
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
      onReloadDashboardSettings={async () => {}}
      restartDashboardBackendCore={async () => true}
      onSaveDashboardSettings={async () => {}}
    />,
  );

  assert.match(markup, /Settings/);
  assert.match(markup, /Prompt prefix/);
  assert.match(markup, /Model Presets/);
  assert.doesNotMatch(markup, /Managed llama\.cpp/);
});

test('presets section renders library controls and effective tools', () => {
  const markup = renderToStaticMarkup(
    <PresetsSection
      dashboardConfig={DASHBOARD_CONFIG}
      selectedSettingsPreset={PRESET}
      selectedSettingsPresetId={PRESET.id}
      renderField={(_, __, children) => <div>{children}</div>}
      setSelectedSettingsPresetId={() => {}}
      updateSettingsDraft={() => {}}
      updatePresetDraft={() => {}}
      onAddPreset={() => {}}
      onDeletePreset={() => {}}
    />,
  );

  assert.match(markup, /Add Preset/);
  assert.match(markup, /Effective tools/);
});

test('managed llama section renders launcher fields and browse controls', () => {
  const capturedFields: string[] = [];
  const markup = renderToStaticMarkup(
    <ManagedLlamaSection
      dashboardConfig={DASHBOARD_CONFIG}
      selectedManagedLlamaPreset={MANAGED_PRESET}
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

  assert.match(markup, /Browse/);
  assert.match(markup, /127\.0\.0\.1:8080/);
  assert.match(markup, /f16/);
  assert.equal(capturedFields.includes('NcpuMoe'), true);
  assert.doesNotMatch(markup, /value="test-model"/);
});

test('managed llama model name is derived from model path and model field is hidden', () => {
  const capturedFields: CapturedField[] = [];
  let updatedConfig: DashboardConfig | null = null;

  const section = ManagedLlamaSection({
    dashboardConfig: DASHBOARD_CONFIG,
    selectedManagedLlamaPreset: MANAGED_PRESET,
    settingsActionBusy: false,
    settingsPathPickerBusyTarget: null,
    renderField: (_, label, children) => {
      capturedFields.push({ label, children });
      return <div>{children}</div>;
    },
    updateSettingsDraft: () => {},
    updateManagedLlamaDraft: (updater) => {
      const nextConfig = structuredClone(DASHBOARD_CONFIG);
      updateActiveManagedLlamaPreset(nextConfig, updater);
      updatedConfig = nextConfig;
    },
    onAddManagedLlamaPreset: () => {},
    onDeleteManagedLlamaPreset: () => {},
    onPickManagedLlamaPath: async () => {},
  });

  const markup = renderToStaticMarkup(section);
  const modelPathField = capturedFields.find((field) => field.label === 'Model path (.gguf)');
  const modelPathInput = modelPathField ? findInputElement(modelPathField.children) : null;

  assert.equal(capturedFields.some((field) => field.label === 'Model'), false);
  assert.doesNotMatch(markup, /value="test-model"/);
  assert.ok(modelPathInput?.props.onChange);
  modelPathInput.props.onChange({ target: { value: 'D:\\personal\\models\\Qwen3.5-27B-Q4_K_M.gguf' } });
  assert.ok(updatedConfig);
  assert.equal(updatedConfig.Server.LlamaCpp.Presets[0]?.Model, 'Qwen3.5-27B-Q4_K_M.gguf');
  assert.equal(updatedConfig.Server.LlamaCpp.Model, 'Qwen3.5-27B-Q4_K_M.gguf');
  assert.equal(updatedConfig.Runtime.Model, 'Qwen3.5-27B-Q4_K_M.gguf');
  assert.equal(updatedConfig.Server.LlamaCpp.Presets[0]?.ModelPath, 'D:\\personal\\models\\Qwen3.5-27B-Q4_K_M.gguf');
});

test('chat tab renders session list and composer', () => {
  const markup = renderToStaticMarkup(
    <ChatTab
      sessions={[CHAT_SESSION]}
      selectedSessionId={CHAT_SESSION.id}
      selectedSession={CHAT_SESSION}
      sessionPromptCacheStats={{
        cacheHitRate: 0,
        promptCacheTokens: 0,
        promptEvalTokens: 0,
      }}
      webPresets={[PRESET]}
      selectedChatPreset={PRESET}
      chatMode="chat"
      isDirectChatMode={true}
      isRepoToolMode={false}
      isThinkingEnabledForCurrentSession={true}
      showSettings={false}
      planRepoRootInput=""
      planMaxTurnsInput="45"
      planThinkingIntervalInput="5"
      contextUsage={CONTEXT_USAGE}
      liveToolPromptTokenCount={null}
      thinkingDraft=""
      answerDraft=""
      planToolCalls={[]}
      chatInput=""
      chatBusy={false}
      chatError={null}
      onSelectSession={() => {}}
      onToggleSettings={() => {}}
      onChangePlanRepoRoot={() => {}}
      onChangePlanMaxTurns={() => {}}
      onChangePlanThinkingInterval={() => {}}
      onChangeChatInput={() => {}}
      onCreateSession={async () => {}}
      onDeleteSession={async () => {}}
      onUpdateSessionPreset={async () => {}}
      onToggleThinking={async () => {}}
      onSavePlanRepoRoot={async () => {}}
      onClearToolContext={async () => {}}
      onCondense={async () => {}}
      onSendPlan={async () => {}}
      onSendRepoSearch={async () => {}}
      onSendMessage={async () => {}}
    />,
  );

  assert.match(markup, /Sessions/);
  assert.match(markup, /Send a local chat message/);
});

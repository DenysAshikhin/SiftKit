import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactElement, ReactNode } from 'react';

import { MetricsTab } from '../src/tabs/MetricsTab';
import { SettingsTab } from '../src/tabs/SettingsTab';
import { ChatTab, buildLiveMessageScrollSignature } from '../src/tabs/ChatTab';
import { buildRepoSearchAutoAppendPayload } from '../src/lib/repo-append-controls';
import { BenchmarkTab } from '../src/tabs/BenchmarkTab';
import { PresetsSection } from '../src/tabs/settings/PresetsSection';
import { ManagedLlamaSection } from '../src/tabs/settings/ManagedLlamaSection';
import { updateActiveManagedLlamaPreset } from '../src/managed-llama-presets';
import { syncDerivedSettingsFields } from '../src/settings-runtime';
import type {
  ChatMessage,
  ChatSession,
  ContextUsage,
  DashboardConfig,
  DashboardManagedLlamaPreset,
  DashboardBenchmarkAttempt,
  DashboardBenchmarkQuestionPreset,
  DashboardBenchmarkSession,
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
  speculativeAcceptedTokens: 15,
  speculativeGeneratedTokens: 20,
  acceptanceRate: 0.75,
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
  inputOutputRatio: 2,
  savedTokens: 3,
  savedPercent: 12,
  compressionRatio: 1.3,
  requestDurationMsTotal: 4000,
  avgRequestMs: 1000,
  avgTokensPerSecond: 8,
  summaryText: '',
} as IdleSummarySnapshot;

const BENCHMARK_PROMPT = {
  id: 'prompt-1',
  title: 'Trace repo-search',
  taskKind: 'repo-search',
  prompt: 'Trace repo-search execution.',
  enabled: true,
  createdAtUtc: '2026-05-13T12:00:00.000Z',
  updatedAtUtc: '2026-05-13T12:00:00.000Z',
} as DashboardBenchmarkQuestionPreset;

const BENCHMARK_SESSION = {
  id: 'session-1',
  status: 'running',
  questionPresetCount: 1,
  caseCount: 1,
  repetitions: 2,
  currentCaseIndex: 0,
  currentPromptIndex: 0,
  currentRepeatIndex: 1,
  restoreStatus: 'pending',
  restoreError: null,
  originalConfigJson: '{}',
  startedAtUtc: '2026-05-13T12:00:00.000Z',
  completedAtUtc: null,
  updatedAtUtc: '2026-05-13T12:00:01.000Z',
} as DashboardBenchmarkSession;

const BENCHMARK_ATTEMPT = {
  id: 'attempt-1',
  sessionId: BENCHMARK_SESSION.id,
  caseId: 'case-1',
  questionPresetId: BENCHMARK_PROMPT.id,
  taskKind: 'repo-search',
  promptTitle: BENCHMARK_PROMPT.title,
  prompt: BENCHMARK_PROMPT.prompt,
  caseLabel: 'Managed / n24-m64',
  managedPresetId: 'managed',
  managedPresetLabel: 'Managed',
  caseIndex: 0,
  promptIndex: 0,
  repeatIndex: 0,
  status: 'completed',
  outputText: 'Found repo-search execution.',
  error: null,
  runId: 'run-1',
  managedRunId: 'managed-run-1',
  durationMs: 1200,
  promptTokensPerSecond: 100,
  generationTokensPerSecond: 42,
  acceptanceRate: 0.5,
  outputTokens: 50,
  thinkingTokens: 5,
  speculativeAcceptedTokens: 10,
  speculativeGeneratedTokens: 20,
  outputQualityScore: null,
  toolUseQualityScore: 8,
  reviewNotes: null,
  reviewedBy: null,
  reviewedAtUtc: null,
  startedAtUtc: '2026-05-13T12:00:00.000Z',
  completedAtUtc: '2026-05-13T12:00:02.000Z',
  updatedAtUtc: '2026-05-13T12:00:02.000Z',
} as DashboardBenchmarkAttempt;

const MANAGED_PRESET = {
  id: 'managed',
  label: 'Managed',
  Model: 'test-model',
  ExternalServerEnabled: false,
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
  Reasoning: 'off',
  ReasoningContent: false,
  PreserveThinking: false,
  SpeculativeEnabled: false,
  SpeculativeType: 'ngram-map-k',
  SpeculativeMtpEnabled: false,
  SpeculativeNgramSizeN: 8,
  SpeculativeNgramSizeM: 16,
  SpeculativeNgramMinHits: 2,
  SpeculativeNgramModNMatch: 24,
  SpeculativeNgramModNMin: 4,
  SpeculativeNgramModNMax: 16,
  SpeculativeDraftMax: 16,
  SpeculativeDraftMin: 4,
  ReasoningBudget: 128,
  ReasoningBudgetMessage: '',
  StartupTimeoutMs: 1000,
  HealthcheckTimeoutMs: 1000,
  HealthcheckIntervalMs: 500,
  SleepIdleSeconds: 600,
  VerboseLogging: false,
} as DashboardManagedLlamaPreset & {
  SpeculativeEnabled: boolean;
  SpeculativeType: string;
  SpeculativeMtpEnabled: boolean;
  SpeculativeNgramSizeN: number;
  SpeculativeNgramSizeM: number;
  SpeculativeNgramMinHits: number;
  SpeculativeDraftMax: number;
  SpeculativeDraftMin: number;
};

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
} as DashboardPreset;

const DASHBOARD_CONFIG = {
  Version: '1',
  Backend: 'llama.cpp',
  PolicyMode: 'conservative',
  RawLogRetention: true,
  IncludeAgentsMd: true,
  IncludeRepoFileListing: true,
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
    Reasoning: 'off',
    ReasoningContent: false,
    PreserveThinking: false,
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
      Reasoning: 'off',
      ReasoningContent: false,
      PreserveThinking: false,
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
      Presets: [MANAGED_PRESET],
      ActivePresetId: MANAGED_PRESET.id,
    },
  },
} as DashboardConfig;

const CHAT_MESSAGE = {
  id: 'message-1',
  role: 'assistant',
  kind: 'assistant_answer',
  content: 'Hello from the assistant.',
  inputTokensEstimate: 12,
  outputTokensEstimate: 4,
  thinkingTokens: 0,
  associatedToolTokens: 0,
  thinkingContent: '',
  createdAtUtc: '2026-04-16T12:00:00.000Z',
  sourceRunId: null,
} as ChatMessage;

const CHAT_THINKING_MESSAGE = {
  id: 'thinking-1',
  role: 'assistant',
  kind: 'assistant_thinking',
  content: 'Inspect the dashboard chat timeline.',
  inputTokensEstimate: 0,
  outputTokensEstimate: 0,
  thinkingTokens: 8,
  associatedToolTokens: 0,
  thinkingContent: '',
  createdAtUtc: '2026-04-16T12:00:01.000Z',
  sourceRunId: null,
} as ChatMessage;

const CHAT_TOOL_MESSAGE = {
  id: 'tool-1',
  role: 'assistant',
  kind: 'assistant_tool_call',
  content: 'rg -n "ChatTab" dashboard/src',
  inputTokensEstimate: 0,
  outputTokensEstimate: 12,
  thinkingTokens: 0,
  associatedToolTokens: 12,
  thinkingContent: '',
  createdAtUtc: '2026-04-16T12:00:02.000Z',
  sourceRunId: 'run-1',
  toolCallCommand: 'rg -n "ChatTab" dashboard/src',
  toolCallTurn: 1,
  toolCallMaxTurns: 4,
  toolCallExitCode: 0,
  toolCallPromptTokenCount: 123,
  toolCallOutputSnippet: 'dashboard/src/tabs/ChatTab.tsx:75:export function ChatTab',
  toolCallOutput: 'dashboard/src/tabs/ChatTab.tsx:75:export function ChatTab\nfull output line',
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

const CHAT_SESSION_WITH_PROMPT_CONTEXT = {
  ...CHAT_SESSION,
  promptContext: {
    id: 'session-1:system-context',
    role: 'system',
    kind: 'system_context',
    label: 'System prompt and tool schema',
    content: '## System prompt\n\nYou are SiftKit.\n\n## Tool schema\n\n{"name":"repo_rg"}',
    createdAtUtc: '2026-04-16T11:00:00.000Z',
    deletable: false,
  },
} as ChatSession;

const CONTEXT_USAGE = {
  shouldCondense: false,
  chatUsedTokens: 10,
  thinkingUsedTokens: 0,
  toolUsedTokens: 0,
  totalUsedTokens: 10,
  remainingTokens: 90,
  warnThresholdTokens: 50,
  contextWindowTokens: 100,
  usedTokens: 10,
  estimatedTokenFallbackTokens: 0,
} as ContextUsage;

type ChatTabProps = React.ComponentProps<typeof ChatTab>;

const DEFAULT_PROMPT_CACHE_STATS = {
  cacheHitRate: null,
  promptCacheTokens: 0,
  promptEvalTokens: 0,
  acceptanceRate: null,
  speculativeAcceptedTokens: 0,
  speculativeGeneratedTokens: 0,
  promptTokensPerSecond: null,
  generationTokensPerSecond: null,
};

function renderChatTab(overrides: Partial<ChatTabProps> = {}): string {
  const baseSession = overrides.selectedSession ?? CHAT_SESSION;
  const props: ChatTabProps = {
    sessions: overrides.sessions ?? [baseSession],
    selectedSessionId: overrides.selectedSessionId ?? baseSession.id,
    selectedSession: baseSession,
    sessionPromptCacheStats: overrides.sessionPromptCacheStats ?? DEFAULT_PROMPT_CACHE_STATS,
    webPresets: overrides.webPresets ?? [],
    selectedChatPreset: overrides.selectedChatPreset ?? null,
    chatMode: overrides.chatMode ?? 'plan',
    isDirectChatMode: overrides.isDirectChatMode ?? false,
    isRepoToolMode: overrides.isRepoToolMode ?? false,
    isThinkingEnabledForCurrentSession: overrides.isThinkingEnabledForCurrentSession ?? false,
    showSettings: overrides.showSettings ?? false,
    planRepoRootInput: overrides.planRepoRootInput ?? '',
    planMaxTurnsInput: overrides.planMaxTurnsInput ?? '',
    contextUsage: overrides.contextUsage ?? null,
    liveToolPromptTokenCount: overrides.liveToolPromptTokenCount ?? null,
    repoSearchAutoAppendPreview: overrides.repoSearchAutoAppendPreview ?? null,
    repoSearchAutoAppendSelection: overrides.repoSearchAutoAppendSelection ?? { includeAgentsMd: true, includeRepoFileListing: true },
    isRepoSearchAutoAppendPreviewLoading: overrides.isRepoSearchAutoAppendPreviewLoading ?? false,
    liveMessages: overrides.liveMessages ?? [],
    chatInput: overrides.chatInput ?? '',
    chatBusy: overrides.chatBusy ?? false,
    chatError: overrides.chatError ?? null,
    onSelectSession: overrides.onSelectSession ?? (() => {}),
    onToggleSettings: overrides.onToggleSettings ?? (() => {}),
    onChangePlanRepoRoot: overrides.onChangePlanRepoRoot ?? (() => {}),
    onChangePlanMaxTurns: overrides.onChangePlanMaxTurns ?? (() => {}),
    onChangeChatInput: overrides.onChangeChatInput ?? (() => {}),
    onSetRepoSearchAutoAppendSelection: overrides.onSetRepoSearchAutoAppendSelection ?? (() => {}),
    onCreateSession: overrides.onCreateSession ?? (async () => {}),
    onDeleteSession: overrides.onDeleteSession ?? (async () => {}),
    onUpdateSessionPreset: overrides.onUpdateSessionPreset ?? (async () => {}),
    onToggleThinking: overrides.onToggleThinking ?? (async () => {}),
    onSavePlanRepoRoot: overrides.onSavePlanRepoRoot ?? (async () => {}),
    onClearToolContext: overrides.onClearToolContext ?? (async () => {}),
    onDeleteMessage: overrides.onDeleteMessage ?? (async () => {}),
    onCondense: overrides.onCondense ?? (async () => {}),
    onSendPlan: overrides.onSendPlan ?? (async () => {}),
    onSendRepoSearch: overrides.onSendRepoSearch ?? (async () => {}),
    onSendMessage: overrides.onSendMessage ?? (async () => {}),
  };
  return renderToStaticMarkup(React.createElement(ChatTab, props));
}

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
  assert.match(markup, /Processed Input \/ Output \/ Thinking/);
  assert.match(markup, /Input \/ Output Ratio/);
  assert.match(markup, /read_lines/);
  assert.doesNotMatch(markup, /task-kind-summary/);
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
  assert.match(markup, /AGENTS\.md/);
  assert.match(markup, /Initial repo file scan/);
  assert.match(markup, /Model Presets/);
  assert.doesNotMatch(markup, /Managed llama\.cpp/);
});

test('benchmark tab renders prompt library, run builder, live logs, sortable metrics, and grades', () => {
  let startCalled = false;
  let cancelCalled = false;
  let gradeAttemptId = '';
  const markup = renderToStaticMarkup(
    <BenchmarkTab
      questionPresets={[BENCHMARK_PROMPT]}
      sessions={[BENCHMARK_SESSION]}
      selectedSession={BENCHMARK_SESSION}
      attempts={[BENCHMARK_ATTEMPT]}
      liveLogLines={['starting attempt', 'finished attempt']}
      managedPresets={[MANAGED_PRESET]}
      selectedQuestionPresetIds={[BENCHMARK_PROMPT.id]}
      selectedManagedPresetIds={[MANAGED_PRESET.id]}
      repetitions={2}
      specOverrideLabel="n24-m64"
      loading={false}
      error={null}
      starting={false}
      cancelling={false}
      sortKey="generationTokensPerSecond"
      onToggleQuestionPreset={() => {}}
      onToggleManagedPreset={() => {}}
      onRepetitionsChange={() => {}}
      onSpecOverrideLabelChange={() => {}}
      onStartBenchmark={async () => { startCalled = true; }}
      onCancelBenchmark={async () => { cancelCalled = true; }}
      onSortChange={() => {}}
      onSelectSession={() => {}}
      onUpdateAttemptGrade={async (attemptId) => { gradeAttemptId = attemptId; }}
    />,
  );

  assert.match(markup, /Benchmark/);
  assert.match(markup, /Question Presets/);
  assert.match(markup, /Trace repo-search/);
  assert.match(markup, /Run Builder/);
  assert.match(markup, /Repetitions/);
  assert.match(markup, /Managed/);
  assert.match(markup, /Live Logs/);
  assert.match(markup, /starting attempt/);
  assert.match(markup, /Output Quality/);
  assert.match(markup, /Tool Use Quality/);
  assert.match(markup, /<th>Notes<\/th>/);
  assert.match(markup, /Past Sessions/);
  assert.match(markup, /Token Speed/);
  assert.match(markup, /Acceptance/);
  assert.match(markup, /Ungraded/);

  assert.equal(startCalled, false);
  assert.equal(cancelCalled, false);
  assert.equal(gradeAttemptId, '');
});

test('settings tab renders ncpu moe field in model presets section', () => {
  const markup = renderToStaticMarkup(
    <SettingsTab
      activeSettingsSection="model-presets"
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

  assert.match(markup, /NcpuMoe/);
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
  assert.equal(capturedFields.includes('Reasoning content'), false);
  assert.equal(capturedFields.includes('Preserve thinking'), false);
  assert.doesNotMatch(markup, /value="test-model"/);
});

test('managed llama section shows thinking preservation controls only when reasoning is enabled', () => {
  const capturedFields: string[] = [];
  const markup = renderToStaticMarkup(
    <ManagedLlamaSection
      dashboardConfig={DASHBOARD_CONFIG}
      selectedManagedLlamaPreset={{
        ...MANAGED_PRESET,
        Reasoning: 'on',
        ReasoningContent: true,
        PreserveThinking: true,
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

  assert.equal(capturedFields.includes('Reasoning content'), true);
  assert.equal(capturedFields.includes('Preserve thinking'), true);
  assert.doesNotMatch(markup, /<option value="auto"/);
});

test('managed llama section hides speculative controls until n-gram speculation is enabled', () => {
  const capturedFields: string[] = [];

  renderToStaticMarkup(
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

  assert.equal(capturedFields.includes('Enable speculative decoding'), true);
  assert.equal(capturedFields.includes('Speculative type'), false);
  assert.equal(capturedFields.includes('SpeculativeDraftMax'), false);
});

function captureManagedLlamaFields(preset: DashboardManagedLlamaPreset): string[] {
  const capturedFields: string[] = [];
  renderToStaticMarkup(
    <ManagedLlamaSection
      dashboardConfig={DASHBOARD_CONFIG}
      selectedManagedLlamaPreset={preset}
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
  return capturedFields;
}

test('managed llama section shows ngram size controls for ngram-map-k speculation', () => {
  const fields = captureManagedLlamaFields({ ...MANAGED_PRESET, SpeculativeEnabled: true });

  assert.equal(fields.includes('Speculative type'), true);
  assert.equal(fields.includes('Combine with MTP'), true);
  assert.equal(fields.includes('SpeculativeNgramSizeN'), true);
  assert.equal(fields.includes('SpeculativeNgramSizeM'), true);
  assert.equal(fields.includes('SpeculativeNgramMinHits'), true);
  assert.equal(fields.includes('SpeculativeNgramModNMatch'), false);
  assert.equal(fields.includes('SpeculativeDraftMax'), false);
});

test('managed llama section shows ngram-mod controls for ngram-mod speculation', () => {
  const fields = captureManagedLlamaFields({
    ...MANAGED_PRESET,
    SpeculativeEnabled: true,
    SpeculativeType: 'ngram-mod' as DashboardManagedLlamaPreset['SpeculativeType'],
  });

  assert.equal(fields.includes('SpeculativeNgramModNMatch'), true);
  assert.equal(fields.includes('SpeculativeNgramModNMin'), true);
  assert.equal(fields.includes('SpeculativeNgramModNMax'), true);
  assert.equal(fields.includes('SpeculativeNgramSizeN'), false);
  assert.equal(fields.includes('SpeculativeDraftMax'), false);
});

test('managed llama section shows draft-token controls when MTP combination is enabled on an ngram type', () => {
  const fields = captureManagedLlamaFields({
    ...MANAGED_PRESET,
    SpeculativeEnabled: true,
    SpeculativeType: 'ngram-mod' as DashboardManagedLlamaPreset['SpeculativeType'],
    SpeculativeMtpEnabled: true,
  });

  assert.equal(fields.includes('Combine with MTP'), true);
  assert.equal(fields.includes('SpeculativeNgramModNMatch'), true);
  assert.equal(fields.includes('SpeculativeDraftMax'), true);
  assert.equal(fields.includes('SpeculativeDraftMin'), true);
});

test('managed llama section hides the Combine with MTP toggle for draft speculation', () => {
  const fields = captureManagedLlamaFields({
    ...MANAGED_PRESET,
    SpeculativeEnabled: true,
    SpeculativeType: 'draft-mtp' as DashboardManagedLlamaPreset['SpeculativeType'],
  });

  assert.equal(fields.includes('Combine with MTP'), false);
});

test('managed llama section shows only draft-token controls for draft-mtp speculation', () => {
  const fields = captureManagedLlamaFields({
    ...MANAGED_PRESET,
    SpeculativeEnabled: true,
    SpeculativeType: 'draft-mtp' as DashboardManagedLlamaPreset['SpeculativeType'],
  });

  assert.equal(fields.includes('Speculative type'), true);
  assert.equal(fields.includes('SpeculativeDraftMax'), true);
  assert.equal(fields.includes('SpeculativeDraftMin'), true);
  assert.equal(fields.includes('SpeculativeNgramSizeN'), false);
  assert.equal(fields.includes('SpeculativeNgramModNMatch'), false);
});

test('managed llama section warns when an MTP combination uses parallel slots', () => {
  const markup = renderToStaticMarkup(
    <ManagedLlamaSection
      dashboardConfig={DASHBOARD_CONFIG}
      selectedManagedLlamaPreset={{
        ...MANAGED_PRESET,
        SpeculativeEnabled: true,
        SpeculativeType: 'ngram-mod' as DashboardManagedLlamaPreset['SpeculativeType'],
        SpeculativeMtpEnabled: true,
        ParallelSlots: 2,
      }}
      settingsActionBusy={false}
      settingsPathPickerBusyTarget={null}
      renderField={(_, __, children) => <div>{children}</div>}
      updateSettingsDraft={() => {}}
      updateManagedLlamaDraft={() => {}}
      onAddManagedLlamaPreset={() => {}}
      onDeleteManagedLlamaPreset={() => {}}
      onPickManagedLlamaPath={async () => {}}
    />,
  );

  assert.match(markup, /role="alert"/);
  assert.match(markup, /MTP/);
});

test('managed llama section warns when mtp speculation uses parallel slots', () => {
  const markup = renderToStaticMarkup(
    <ManagedLlamaSection
      dashboardConfig={DASHBOARD_CONFIG}
      selectedManagedLlamaPreset={{
        ...MANAGED_PRESET,
        SpeculativeEnabled: true,
        SpeculativeType: 'draft-mtp' as DashboardManagedLlamaPreset['SpeculativeType'],
        ParallelSlots: 2,
      }}
      settingsActionBusy={false}
      settingsPathPickerBusyTarget={null}
      renderField={(_, __, children) => <div>{children}</div>}
      updateSettingsDraft={() => {}}
      updateManagedLlamaDraft={() => {}}
      onAddManagedLlamaPreset={() => {}}
      onDeleteManagedLlamaPreset={() => {}}
      onPickManagedLlamaPath={async () => {}}
    />,
  );

  assert.match(markup, /role="alert"/);
  assert.match(markup, /MTP/);
  assert.match(markup, /parallel slots/);
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
      updatedConfig = syncDerivedSettingsFields(nextConfig);
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
  assert.equal(updatedConfig.Runtime.Model, 'Qwen3.5-27B-Q4_K_M.gguf');
  assert.equal(updatedConfig.Server.LlamaCpp.Presets[0]?.ModelPath, 'D:\\personal\\models\\Qwen3.5-27B-Q4_K_M.gguf');
});

test('managed llama external server setting updates active preset and server config', () => {
  let updatedConfig: DashboardConfig | null = null;

  ManagedLlamaSection({
    dashboardConfig: DASHBOARD_CONFIG,
    selectedManagedLlamaPreset: MANAGED_PRESET,
    settingsActionBusy: false,
    settingsPathPickerBusyTarget: null,
    renderField: (_, __, children) => <div>{children}</div>,
    updateSettingsDraft: () => {},
    updateManagedLlamaDraft: (updater) => {
      const nextConfig = structuredClone(DASHBOARD_CONFIG);
      updateActiveManagedLlamaPreset(nextConfig, updater);
      updatedConfig = syncDerivedSettingsFields(nextConfig);
    },
    onAddManagedLlamaPreset: () => {},
    onDeleteManagedLlamaPreset: () => {},
    onPickManagedLlamaPath: async () => {},
  });

  const nextConfig = structuredClone(DASHBOARD_CONFIG);
  updateActiveManagedLlamaPreset(nextConfig, (preset) => {
    preset.ExternalServerEnabled = true;
  });
  updatedConfig = nextConfig;

  assert.ok(updatedConfig);
  assert.equal(updatedConfig.Server.LlamaCpp.Presets[0]?.ExternalServerEnabled, true);
});

test('managed llama section renders external server controls', () => {
  const capturedFields: string[] = [];
  const markup = renderToStaticMarkup(
    <ManagedLlamaSection
      dashboardConfig={DASHBOARD_CONFIG}
      selectedManagedLlamaPreset={{ ...MANAGED_PRESET, ExternalServerEnabled: true }}
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
      onTestLlamaCppBaseUrl={async () => {}}
    />,
  );

  assert.equal(capturedFields.includes('External llama.cpp server'), true);
  assert.match(markup, /Test/);
  assert.doesNotMatch(markup, /Browse/);
});

test('managed llama section warns when llama base url is remote', () => {
  const capturedFields: { label: string; className?: string }[] = [];
  const markup = renderToStaticMarkup(
    <ManagedLlamaSection
      dashboardConfig={DASHBOARD_CONFIG}
      selectedManagedLlamaPreset={{ ...MANAGED_PRESET, BaseUrl: 'http://192.168.1.20:8097' }}
      settingsActionBusy={false}
      settingsPathPickerBusyTarget={null}
      renderField={(_, label, children, className) => {
        capturedFields.push({ label, className });
        return <div>{children}</div>;
      }}
      updateSettingsDraft={() => {}}
      updateManagedLlamaDraft={() => {}}
      onAddManagedLlamaPreset={() => {}}
      onDeleteManagedLlamaPreset={() => {}}
      onPickManagedLlamaPath={async () => {}}
      onTestLlamaCppBaseUrl={async () => {}}
    />,
  );

  assert.equal(capturedFields.find((field) => field.label === 'Base URL')?.className, 'settings-live-field-danger');
  assert.match(markup, /Remote llama\.cpp URL detected/);
  assert.match(markup, /backend URL also needs to use a non-local host/);
});

test('managed llama section does not warn for local llama base url', () => {
  const capturedFields: { label: string; className?: string }[] = [];
  const markup = renderToStaticMarkup(
    <ManagedLlamaSection
      dashboardConfig={DASHBOARD_CONFIG}
      selectedManagedLlamaPreset={{ ...MANAGED_PRESET, BaseUrl: 'http://localhost:8097' }}
      settingsActionBusy={false}
      settingsPathPickerBusyTarget={null}
      renderField={(_, label, children, className) => {
        capturedFields.push({ label, className });
        return <div>{children}</div>;
      }}
      updateSettingsDraft={() => {}}
      updateManagedLlamaDraft={() => {}}
      onAddManagedLlamaPreset={() => {}}
      onDeleteManagedLlamaPreset={() => {}}
      onPickManagedLlamaPath={async () => {}}
      onTestLlamaCppBaseUrl={async () => {}}
    />,
  );

  assert.equal(capturedFields.find((field) => field.label === 'Base URL')?.className, undefined);
  assert.doesNotMatch(markup, /Remote llama\.cpp URL detected/);
});

test('chat tab renders session list and composer', () => {
  const markup = renderChatTab({
    sessionPromptCacheStats: {
      cacheHitRate: 0,
      promptCacheTokens: 0,
      promptEvalTokens: 0,
      acceptanceRate: 0.75,
      speculativeAcceptedTokens: 15,
      speculativeGeneratedTokens: 20,
      promptTokensPerSecond: 120,
      generationTokensPerSecond: 80,
    },
    webPresets: [PRESET],
    selectedChatPreset: PRESET,
    chatMode: 'chat',
    isDirectChatMode: true,
    isThinkingEnabledForCurrentSession: true,
    planMaxTurnsInput: '45',
    contextUsage: CONTEXT_USAGE,
  });

  assert.match(markup, /Sessions/);
  assert.match(markup, /Send a local chat message/);
  assert.match(markup, /Acceptance:/);
  assert.match(markup, /Prompt\/s:/);
  assert.match(markup, /Generation\/s:/);
  assert.doesNotMatch(markup, /think every/u);
});

test('chat tab renders context usage thinking breakdown', () => {
  const markup = renderChatTab({
    webPresets: [PRESET],
    selectedChatPreset: PRESET,
    chatMode: 'chat',
    isDirectChatMode: true,
    isThinkingEnabledForCurrentSession: true,
    showSettings: true,
    planMaxTurnsInput: '45',
    contextUsage: {
      ...CONTEXT_USAGE,
      chatUsedTokens: 24,
      thinkingUsedTokens: 7,
      toolUsedTokens: 3,
      totalUsedTokens: 27,
      remainingTokens: 73,
    },
  });

  assert.match(markup, /Thinking\/reasoning: 7/);
});

test('chat tab renders typed thinking and tool bubbles with trash and expandable output', () => {
  const session = {
    ...CHAT_SESSION,
    messages: [CHAT_THINKING_MESSAGE, CHAT_TOOL_MESSAGE, CHAT_MESSAGE],
  } as ChatSession;
  const markup = renderChatTab({
    selectedSession: session,
    webPresets: [PRESET],
    selectedChatPreset: PRESET,
    chatMode: 'repo-search',
    isRepoToolMode: true,
    isThinkingEnabledForCurrentSession: true,
    planMaxTurnsInput: '45',
    contextUsage: CONTEXT_USAGE,
  });

  assert.match(markup, /assistant thinking/);
  assert.match(markup, /Inspect the dashboard chat timeline/);
  assert.match(markup, /assistant tool/);
  assert.match(markup, /rg -n &quot;ChatTab&quot; dashboard\/src/);
  assert.match(markup, /aria-label="Delete message"/);
  assert.match(markup, /aria-label="Show tool result"/);
  assert.match(markup, /dashboard\/src\/tabs\/ChatTab\.tsx:75:export function ChatTab/);
  assert.doesNotMatch(markup, /live-stream-boxes/);
});

test('chat tab renders only explicit model-visible tool commands', () => {
  const session = {
    ...CHAT_SESSION,
    messages: [{
      ...CHAT_TOOL_MESSAGE,
      content: 'rg -n "tool.call|toolCall|ToolCall" --no-ignore --ignore-case --glob "!**/.git/**"',
      toolCallCommand: 'rg -n "tool.call|toolCall|ToolCall"',
    }],
  } as ChatSession;
  const markup = renderChatTab({
    selectedSession: session,
    webPresets: [PRESET],
    selectedChatPreset: PRESET,
    chatMode: 'repo-search',
    isRepoToolMode: true,
    isThinkingEnabledForCurrentSession: true,
    planMaxTurnsInput: '45',
    contextUsage: CONTEXT_USAGE,
  });

  assert.match(markup, /rg -n &quot;tool\.call\|toolCall\|ToolCall&quot;<\/code>/u);
  assert.doesNotMatch(markup, /--no-ignore|--ignore-case|--glob/u);
});

test('chat tab live scroll signature changes when streamed content grows', () => {
  const before = buildLiveMessageScrollSignature([
    { ...CHAT_THINKING_MESSAGE, id: 'live-thinking', content: 'first chunk' },
  ]);
  const after = buildLiveMessageScrollSignature([
    { ...CHAT_THINKING_MESSAGE, id: 'live-thinking', content: 'first chunk\nsecond chunk' },
  ]);

  assert.notEqual(before, after);
});

test('renderChatTab accepts overrides and produces stable markup', () => {
  const session: ChatSession = { ...CHAT_SESSION, title: 'renderer-fixture-title' };
  const markup = renderChatTab({
    selectedSessionId: session.id,
    selectedSession: session,
    sessions: [session],
    chatBusy: true,
  });
  assert.equal(typeof markup, 'string');
  assert.equal(markup.includes('renderer-fixture-title'), true);
});

test('buildLiveMessageScrollSignature changes when content of identical length is replaced', () => {
  const baseMessage: ChatMessage = {
    id: 'm1',
    role: 'assistant',
    kind: 'assistant_tool_call',
    content: 'abc',
    inputTokensEstimate: 0,
    outputTokensEstimate: 0,
    thinkingTokens: 0,
    associatedToolTokens: 0,
    createdAtUtc: '2026-06-03T12:00:00.000Z',
    sourceRunId: null,
    toolCallCommand: 'rg foo',
    toolCallOutputSnippet: 'hit',
    toolCallOutput: '',
    toolCallStatus: 'running',
    toolCallExitCode: null,
  };
  const before = buildLiveMessageScrollSignature([baseMessage]);
  const after = buildLiveMessageScrollSignature([{ ...baseMessage, toolCallOutputSnippet: 'hot' }]);
  assert.notEqual(before, after, 'equal-length replacement must change scroll signature');
});

test('chat tab renders non-deletable collapsed system context bubble first', () => {
  const markup = renderChatTab({
    selectedSession: CHAT_SESSION_WITH_PROMPT_CONTEXT,
    webPresets: [PRESET],
    selectedChatPreset: PRESET,
    chatMode: 'repo-search',
    isRepoToolMode: true,
    isThinkingEnabledForCurrentSession: true,
    planMaxTurnsInput: '45',
    contextUsage: CONTEXT_USAGE,
  });

  assert.match(markup, /system \| first message/u);
  assert.match(markup, /System prompt and tool schema/u);
  assert.match(markup, /You are SiftKit/u);
  assert.match(markup, /repo_rg/u);
  assert.equal(markup.indexOf('system | first message') < markup.indexOf('assistant |'), true);
  assert.equal(markup.match(/aria-label="Delete message"/gu)?.length, 1);
});

test('chat tab renders fallback system context bubble when session metadata is missing', () => {
  const session = { ...CHAT_SESSION, promptContext: undefined } as ChatSession;
  const preset = {
    ...PRESET,
    presetKind: 'repo-search',
    promptPrefix: 'Use strict repo evidence.',
    allowedTools: ['repo_rg', 'repo_read_file'],
  } as DashboardPreset;
  const markup = renderChatTab({
    selectedSession: session,
    webPresets: [preset],
    selectedChatPreset: preset,
    chatMode: 'repo-search',
    isRepoToolMode: true,
    isThinkingEnabledForCurrentSession: true,
    planRepoRootInput: 'C:\\repo',
    planMaxTurnsInput: '45',
    contextUsage: CONTEXT_USAGE,
  });

  assert.match(markup, /system \| first message/u);
  assert.match(markup, /Use strict repo evidence/u);
  assert.match(markup, /repo_rg/u);
  assert.match(markup, /repo_read_file/u);
});

test('chat tab renders repo-search auto-append controls before first message', () => {
  const emptySession = {
    ...CHAT_SESSION,
    messages: [],
  } as ChatSession;
  const markup = renderChatTab({
    selectedSession: emptySession,
    webPresets: [PRESET],
    selectedChatPreset: PRESET,
    chatMode: 'repo-search',
    isRepoToolMode: true,
    repoSearchAutoAppendPreview: {
      agentsMd: {
        key: 'agentsMd',
        label: 'AGENTS.md',
        enabledDefault: true,
        available: true,
        tokenCount: 42,
        tokenSource: 'estimate',
      },
      repoFileListing: {
        key: 'repoFileListing',
        label: 'Files',
        enabledDefault: true,
        available: true,
        tokenCount: 314,
        tokenSource: 'estimate',
      },
    },
    repoSearchAutoAppendSelection: { includeAgentsMd: true, includeRepoFileListing: false },
    isRepoSearchAutoAppendPreviewLoading: false,
    onSetRepoSearchAutoAppendSelection: () => {},
    planMaxTurnsInput: '45',
    contextUsage: CONTEXT_USAGE,
  });

  assert.match(markup, /repo-auto-append-row/u);
  assert.match(markup, /aria-label="Disable AGENTS\.md auto-append"/u);
  assert.match(markup, /42 tokens/u);
  assert.match(markup, /aria-label="Enable file scan auto-append"/u);
  assert.match(markup, /314 tokens/u);
  assert.equal(/repo-auto-append-button on/u.test(markup), true);
  assert.equal(/repo-auto-append-button off/u.test(markup), true);
});

test('chat tab hides repo-search auto-append controls outside first empty repo-search turn', () => {
  const emptySession = { ...CHAT_SESSION, messages: [] } as ChatSession;
  const preview = {
    agentsMd: {
      key: 'agentsMd' as const,
      label: 'AGENTS.md',
      enabledDefault: true,
      available: true,
      tokenCount: 42,
      tokenSource: 'estimate' as const,
    },
    repoFileListing: {
      key: 'repoFileListing' as const,
      label: 'Files',
      enabledDefault: true,
      available: true,
      tokenCount: 314,
      tokenSource: 'estimate' as const,
    },
  };

  assert.doesNotMatch(renderChatTab({
    selectedSession: emptySession,
    chatMode: 'chat',
    isDirectChatMode: true,
    repoSearchAutoAppendPreview: preview,
  }), /repo-auto-append-row/u);

  assert.doesNotMatch(renderChatTab({
    selectedSession: CHAT_SESSION,
    chatMode: 'repo-search',
    isRepoToolMode: true,
    repoSearchAutoAppendPreview: preview,
  }), /repo-auto-append-row/u);
});

test('repo-search auto-append helper maps toggled controls into request payload overrides', () => {
  assert.deepEqual(
    buildRepoSearchAutoAppendPayload({
      includeAgentsMd: false,
      includeRepoFileListing: true,
    }),
    {
      includeAgentsMd: false,
      includeRepoFileListing: true,
    },
  );
});

test('chat tab sorts persisted messages oldest first and keeps live messages last', () => {
  const older = { ...CHAT_MESSAGE, id: 'older', role: 'user', kind: 'user_text', content: 'older message', createdAtUtc: '2026-04-16T12:00:00.000Z' } as ChatMessage;
  const newer = { ...CHAT_MESSAGE, id: 'newer', content: 'newer persisted message', createdAtUtc: '2026-04-16T12:01:00.000Z' } as ChatMessage;
  const live = { ...CHAT_MESSAGE, id: 'live-answer', content: 'currently streaming message', createdAtUtc: '2026-04-16T11:59:00.000Z' } as ChatMessage;
  const session = { ...CHAT_SESSION, messages: [newer, older] } as ChatSession;
  const markup = renderChatTab({
    selectedSession: session,
    webPresets: [PRESET],
    selectedChatPreset: PRESET,
    chatMode: 'chat',
    isDirectChatMode: true,
    isThinkingEnabledForCurrentSession: true,
    planMaxTurnsInput: '45',
    contextUsage: CONTEXT_USAGE,
    liveMessages: [live],
    chatBusy: true,
  });

  assert.equal(markup.indexOf('older message') < markup.indexOf('newer persisted message'), true);
  assert.equal(markup.indexOf('newer persisted message') < markup.indexOf('currently streaming message'), true);
});

test('metrics tab renders speculative acceptance graph', () => {
  const markup = renderToStaticMarkup(
    <MetricsTab
      metrics={[METRIC_DAY]}
      idleSummarySnapshots={[IDLE_SNAPSHOT]}
      recentIdlePoints={[IDLE_SNAPSHOT]}
      latestIdleSnapshot={IDLE_SNAPSHOT}
      sortedToolMetricRows={[]}
      taskRunsGraphSeries={[]}
    />,
  );

  assert.match(markup, /Speculative Acceptance Rate/);
  assert.match(markup, /Accepted Tokens/);
  assert.match(markup, /Generated Tokens/);
});

import { useEffect, useRef, useState } from 'react';
import {
  cancelBenchmarkSession,
  deleteRunLogs,
  getDashboardConfig,
  getBenchmarkQuestionPresets,
  getBenchmarkSession,
  getBenchmarkSessions,
  getDashboardHealth,
  getIdleSummary,
  getMetrics,
  pickManagedFile,
  openBenchmarkSessionEvents,
  testLlamaCppBaseUrl as testLlamaCppBaseUrlRequest,
  getRunDetail,
  getRuns,
  previewRunLogDelete,
  restartBackend,
  startBenchmarkSession,
  updateDashboardConfig,
  updateBenchmarkAttemptGrade,
} from './api';
import {
  buildRunLogDeleteCriteria,
  describeRunLogDeleteCriteria,
  normalizeRunLogTypeFilter,
  RUN_LOG_TYPE_PRESETS,
  toggleRunLogTypeFilter,
} from './run-log-admin';
import {
  createPresetIdFromLabel,
  getDefaultWebPresetId,
  getPresetById,
  getPresetFamily,
  getSurfacePresets,
} from './dashboard-presets';
import {
  addManagedLlamaPreset,
  applyManagedLlamaPresetSelection,
  deleteManagedLlamaPreset,
  updateActiveManagedLlamaPreset,
} from './managed-llama-presets';
import {
  getDefaultToolsForOperationMode,
  getFallbackPresetId,
  getNextPresetIdAfterDelete,
} from './preset-editor';
import { getDashboardView } from './dashboard-route';
import { getDirtyActionRequirement, type DirtyContinuation } from './settings-flow';
import { type SettingsSectionId } from './settings-sections';
import { buildManagedLlamaRestartFailureModal } from './managed-llama-restart';
import { deriveRuntimeModelId, syncDerivedSettingsFields } from './settings-runtime';
import { SettingsMockupPage } from './settings-mockup';
import { buildTaskRunsSeries, buildToolMetricRows } from './metrics-view';
import type { InteractiveSeries } from './components/InteractiveGraph';
import { buildRepoSearchChatSteps } from './lib/chat-steps';
import { useChatSessions } from './hooks/useChatSessions';
import { useLiveMessages } from './hooks/useLiveMessages';
import { useContextUsage } from './hooks/useContextUsage';
import { usePlanInputs } from './hooks/usePlanInputs';
import { useRepoSearchAutoAppend } from './hooks/useRepoSearchAutoAppend';
import { useChatComposer, describeStreamError } from './hooks/useChatComposer';
import {
  buildRunsSignature,
  classifyRunGroup,
  cloneDashboardConfig,
  getDashboardConfigSignature,
  getSessionTelemetryStats,
  readSearchParams,
  writeSearchParams,
} from './lib/format';
import { RunsTab } from './tabs/RunsTab';
import { MetricsTab } from './tabs/MetricsTab';
import { ChatTab } from './tabs/ChatTab';
import { SettingsTab } from './tabs/SettingsTab';
import { BenchmarkTab } from './tabs/BenchmarkTab';
import type { DashboardBenchmarkAttempt, DashboardBenchmarkQuestionPreset, DashboardBenchmarkSession, DashboardBenchmarkSortKey, DashboardConfig, DashboardManagedLlamaPreset, DashboardPreset, IdleSummarySnapshot, MetricDay, RunGroupFilter, TaskMetricDay, ToolStatsByTask, RunDetailResponse, RunLogDeleteType, RunRecord } from './types';

type TabKey = 'runs' | 'metrics' | 'benchmark' | 'chat' | 'settings';
type RunGroupKey = Exclude<RunGroupFilter, ''>;
type ToastLevel = 'info' | 'warning' | 'error';
type ToastMessage = {
  id: string;
  level: ToastLevel;
  text: string;
};

export function App() {
  const dashboardView = getDashboardView(window.location.pathname);
  return dashboardView === 'mockup' ? <SettingsMockupPage /> : <DashboardApp />;
}

function DashboardApp() {
  const params = readSearchParams();
  const [tab, setTab] = useState<TabKey>((params.get('tab') as TabKey) || 'runs');
  const [menuOpen, setMenuOpen] = useState(false);

  const [runs, setRuns] = useState<RunRecord[]>([]);
  const [runsLoading, setRunsLoading] = useState(false);
  const [runsError, setRunsError] = useState<string | null>(null);
  const [search, setSearch] = useState(params.get('search') || '');
  const [kindFilter, setKindFilter] = useState<RunGroupFilter>(normalizeRunLogTypeFilter(params.get('kind') || ''));
  const [statusFilter, setStatusFilter] = useState(params.get('status') || '');
  const [selectedRunId, setSelectedRunId] = useState(params.get('run') || '');
  const [selectedRunDetail, setSelectedRunDetail] = useState<RunDetailResponse | null>(null);
  const [repoSearchSimpleFlow, setRepoSearchSimpleFlow] = useState(true);
  const [dashboardRefreshToken, setDashboardRefreshToken] = useState(0);
  const runsSignatureRef = useRef<string>('');
  const runsLoadedRef = useRef<boolean>(false);
  const [showRunDeleteModal, setShowRunDeleteModal] = useState(false);
  const [runDeleteMode, setRunDeleteMode] = useState<'count' | 'before_date'>('count');
  const [runDeleteType, setRunDeleteType] = useState<RunLogDeleteType>('all');
  const [runDeleteCountInput, setRunDeleteCountInput] = useState('25');
  const [runDeleteBeforeDate, setRunDeleteBeforeDate] = useState('');
  const [runDeletePreviewCount, setRunDeletePreviewCount] = useState<number | null>(null);
  const [runDeletePreviewBusy, setRunDeletePreviewBusy] = useState(false);
  const [runDeleteBusy, setRunDeleteBusy] = useState(false);
  const [runDeleteError, setRunDeleteError] = useState<string | null>(null);

  const [metrics, setMetrics] = useState<MetricDay[]>([]);
  const [taskMetrics, setTaskMetrics] = useState<TaskMetricDay[]>([]);
  const [toolMetrics, setToolMetrics] = useState<ToolStatsByTask | null>(null);
  const [metricsError, setMetricsError] = useState<string | null>(null);
  const [idleSummarySnapshots, setIdleSummarySnapshots] = useState<IdleSummarySnapshot[]>([]);

  const [benchmarkQuestionPresets, setBenchmarkQuestionPresets] = useState<DashboardBenchmarkQuestionPreset[]>([]);
  const [benchmarkSessions, setBenchmarkSessions] = useState<DashboardBenchmarkSession[]>([]);
  const [selectedBenchmarkSessionId, setSelectedBenchmarkSessionId] = useState(params.get('benchmarkSession') || '');
  const [selectedBenchmarkSession, setSelectedBenchmarkSession] = useState<DashboardBenchmarkSession | null>(null);
  const [benchmarkAttempts, setBenchmarkAttempts] = useState<DashboardBenchmarkAttempt[]>([]);
  const [benchmarkLiveLogLines, setBenchmarkLiveLogLines] = useState<string[]>([]);
  const [selectedBenchmarkQuestionPresetIds, setSelectedBenchmarkQuestionPresetIds] = useState<string[]>([]);
  const [selectedBenchmarkManagedPresetIds, setSelectedBenchmarkManagedPresetIds] = useState<string[]>([]);
  const [benchmarkRepetitions, setBenchmarkRepetitions] = useState(1);
  const [benchmarkSpecOverrideLabel, setBenchmarkSpecOverrideLabel] = useState('Current spec settings');
  const [benchmarkSortKey, setBenchmarkSortKey] = useState<DashboardBenchmarkSortKey>('generationTokensPerSecond');
  const [benchmarkLoading, setBenchmarkLoading] = useState(false);
  const [benchmarkError, setBenchmarkError] = useState<string | null>(null);
  const [benchmarkStarting, setBenchmarkStarting] = useState(false);
  const [benchmarkCancelling, setBenchmarkCancelling] = useState(false);

  const [chatError, setChatError] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [dashboardConfig, setDashboardConfig] = useState<DashboardConfig | null>(null);
  const [savedDashboardConfig, setSavedDashboardConfig] = useState<DashboardConfig | null>(null);
  const [settingsLoading, setSettingsLoading] = useState(false);
  const [settingsSaving, setSettingsSaving] = useState(false);
  const [settingsRestarting, setSettingsRestarting] = useState(false);
  const [settingsPathPickerBusyTarget, setSettingsPathPickerBusyTarget] = useState<'ExecutablePath' | 'ModelPath' | null>(null);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [settingsSavedAtUtc, setSettingsSavedAtUtc] = useState<string | null>(null);
  const [activeSettingsSection, setActiveSettingsSection] = useState<SettingsSectionId>('general');
  const [selectedSettingsPresetId, setSelectedSettingsPresetId] = useState<string | null>(null);
  const [pendingSettingsContinuation, setPendingSettingsContinuation] = useState<DirtyContinuation | null>(null);
  const [showSettingsConfirm, setShowSettingsConfirm] = useState(false);
  const [settingsRestartFailureModal, setSettingsRestartFailureModal] = useState<{ title: string; message: string } | null>(null);
  const [toasts, setToasts] = useState<ToastMessage[]>([]);

  const live = useLiveMessages();
  const contextHook = useContextUsage();
  const chatSessionsHook = useChatSessions({
    onError: (error) => setChatError(describeStreamError(error)),
    initialSelectedSessionId: params.get('session') || '',
    refreshToken: dashboardRefreshToken,
    buildCreateSessionRequest: () => ({
      title: `Session ${new Date().toLocaleTimeString()}`,
      model: dashboardConfig?.Runtime.Model || 'Qwen3.5-9B-Q8_0.gguf',
      presetId: getDefaultWebPresetId(dashboardConfig),
    }),
    confirmDeleteSession: () => window.confirm('Delete this chat session permanently?'),
    confirmClearToolContext: () => window.confirm('Discard all hidden tool-call context for this session?'),
    applyContextUsage: contextHook.setContextUsage,
  });

  const groupedRuns = runs.reduce<Record<RunGroupKey, RunRecord[]>>((accumulator, run) => {
    const key = classifyRunGroup(run.kind);
    accumulator[key].push(run);
    return accumulator;
  }, {
    summary: [],
    chat: [],
    repo_search: [],
    planner: [],
    other: [],
  });
  const latestIdleSnapshot = idleSummarySnapshots[0] || null;
  const recentIdlePoints = idleSummarySnapshots
    .slice(0, 20)
    .reverse();
  const sortedToolMetricRows = buildToolMetricRows(toolMetrics);
  const taskRunsGraphSeries: InteractiveSeries[] = buildTaskRunsSeries(taskMetrics).map((entry) => ({
    key: entry.key,
    title: entry.title,
    unit: '',
    color: entry.color,
    points: entry.points,
  }));

  function dismissToast(id: string): void {
    setToasts((previous) => previous.filter((toast) => toast.id !== id));
  }

  function enqueueToast(level: ToastLevel, text: string): void {
    const normalized = String(text || '').trim();
    if (!normalized) {
      return;
    }
    const id = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    setToasts((previous) => [...previous, { id, level, text: normalized }].slice(-5));
    window.setTimeout(() => {
      setToasts((previous) => previous.filter((toast) => toast.id !== id));
    }, 9000);
  }

  function requestDashboardDataRefresh(): void {
    runsSignatureRef.current = '';
    runsLoadedRef.current = false;
    setDashboardRefreshToken((previous) => previous + 1);
  }

  function openRunDeleteModal(): void {
    setRunDeleteMode('count');
    setRunDeleteType(kindFilter || 'all');
    setRunDeleteCountInput('25');
    setRunDeleteBeforeDate('');
    setRunDeletePreviewCount(null);
    setRunDeletePreviewBusy(false);
    setRunDeleteBusy(false);
    setRunDeleteError(null);
    setShowRunDeleteModal(true);
  }

  function closeRunDeleteModal(): void {
    if (runDeleteBusy) {
      return;
    }
    setShowRunDeleteModal(false);
    setRunDeleteError(null);
    setRunDeletePreviewBusy(false);
  }

  async function handleConfirmRunDelete(): Promise<void> {
    if (!runDeleteCriteria || runDeleteBusy) {
      return;
    }
    setRunDeleteBusy(true);
    setRunDeleteError(null);
    try {
      const response = await deleteRunLogs(runDeleteCriteria);
      const deletedIds = new Set(response.deletedRunIds);
      if (deletedIds.size > 0) {
        setRuns((previous) => previous.filter((run) => !deletedIds.has(run.id)));
      }
      if (selectedRunId && deletedIds.has(selectedRunId)) {
        setSelectedRunId('');
        setSelectedRunDetail(null);
      }
      requestDashboardDataRefresh();
      setShowRunDeleteModal(false);
      enqueueToast('warning', response.deletedCount > 0 ? `${runDeleteSummary || 'Deleted logs'}.` : 'No logs matched the selected criteria.');
    } catch (error) {
      setRunDeleteError(error instanceof Error ? error.message : String(error));
    } finally {
      setRunDeleteBusy(false);
    }
  }

  const isRepoSearchRunSelected = selectedRunDetail
    ? classifyRunGroup(selectedRunDetail.run.kind) === 'repo_search'
    : false;
  const repoSearchChatSteps = selectedRunDetail ? buildRepoSearchChatSteps(selectedRunDetail.events) : [];
  const selectedSession = chatSessionsHook.selectedSession;
  const isThinkingEnabledForCurrentSession = selectedSession?.thinkingEnabled !== false;
  const webPresets = getSurfacePresets(dashboardConfig, 'web');
  const selectedSettingsPreset = dashboardConfig
    ? dashboardConfig.Presets.find((preset) => preset.id === selectedSettingsPresetId) ?? dashboardConfig.Presets[0] ?? null
    : null;
  const selectedManagedLlamaPreset = dashboardConfig
    ? dashboardConfig.Server.LlamaCpp.Presets.find((preset) => preset.id === dashboardConfig.Server.LlamaCpp.ActivePresetId)
      ?? dashboardConfig.Server.LlamaCpp.Presets[0]
      ?? null
    : null;
  const selectedChatPreset = getPresetById(dashboardConfig, selectedSession?.presetId)
    || getPresetById(dashboardConfig, selectedSession?.mode)
    || webPresets[0]
    || null;
  const chatMode = getPresetFamily(dashboardConfig, selectedSession);
  const isDirectChatMode = chatMode === 'chat' || chatMode === 'summary';
  const isRepoToolMode = chatMode === 'plan' || chatMode === 'repo-search';
  const sessionPromptCacheStats = getSessionTelemetryStats(selectedSession);

  const planInputs = usePlanInputs({
    selectedSession,
    selectedChatPreset,
  });

  const autoAppend = useRepoSearchAutoAppend({
    selectedSession,
    chatMode,
    planRepoRootInput: planInputs.planRepoRootInput,
    liveMessages: live.liveMessages,
    onError: (error) => setChatError(describeStreamError(error)),
  });

  const composer = useChatComposer({
    selectedSession,
    selectedChatPreset,
    live,
    context: contextHook,
    refreshSessions: chatSessionsHook.refreshSessions,
    applySessionResponse: chatSessionsHook.applySessionResponse,
    planRepoRootInput: planInputs.planRepoRootInput,
    planMaxTurnsInput: planInputs.planMaxTurnsInput,
    isThinkingEnabledForCurrentSession,
    repoSearchAutoAppendSelection: autoAppend.selection,
    onError: (message) => setChatError(message),
    resetError: () => setChatError(null),
    setChatBusy: chatSessionsHook.setChatBusy,
  });
  const settingsDirty = dashboardConfig !== null
    && savedDashboardConfig !== null
    && getDashboardConfigSignature(dashboardConfig) !== getDashboardConfigSignature(savedDashboardConfig);
  const settingsActionBusy = settingsLoading || settingsSaving || settingsRestarting || settingsPathPickerBusyTarget !== null;
  const settingsRestartSupported = dashboardConfig?.Backend === 'llama.cpp';
  const benchmarkManagedPresets = dashboardConfig?.Server.LlamaCpp.Presets ?? [];
  const sortedBenchmarkAttempts = [...benchmarkAttempts].sort((left, right) => {
    if (benchmarkSortKey === 'completionSpeed') {
      return Number(left.durationMs || 0) - Number(right.durationMs || 0);
    }
    if (benchmarkSortKey === 'failureCount') {
      return Number(left.status === 'failed') - Number(right.status === 'failed');
    }
    if (benchmarkSortKey === 'sampleCount') {
      return left.repeatIndex - right.repeatIndex;
    }
    return Number(right[benchmarkSortKey] || 0) - Number(left[benchmarkSortKey] || 0);
  });
  const runDeleteCriteria = buildRunLogDeleteCriteria({
    mode: runDeleteMode,
    type: runDeleteType,
    countInput: runDeleteCountInput,
    beforeDate: runDeleteBeforeDate,
  });
  const runDeleteSummary = runDeleteCriteria
    ? describeRunLogDeleteCriteria(runDeleteCriteria, runDeletePreviewCount ?? 0)
    : null;

  useEffect(() => {
    writeSearchParams({
      tab,
      search: search || null,
      kind: kindFilter || null,
      status: statusFilter || null,
      run: selectedRunId || null,
      session: chatSessionsHook.selectedSessionId || null,
      benchmarkSession: selectedBenchmarkSessionId || null,
    });
  }, [tab, search, kindFilter, statusFilter, selectedRunId, chatSessionsHook.selectedSessionId, selectedBenchmarkSessionId]);

  useEffect(() => {
    const onPointerDown = (event: MouseEvent): void => {
      const target = event.target as HTMLElement | null;
      if (!target) {
        return;
      }
      if (target.closest('.topbar-menu')) {
        return;
      }
      setMenuOpen(false);
    };
    window.addEventListener('mousedown', onPointerDown);
    return () => {
      window.removeEventListener('mousedown', onPointerDown);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    async function refreshRuns() {
      if (!runsLoadedRef.current) {
        setRunsLoading(true);
      }
      setRunsError(null);
      try {
        const hasSearch = search.trim().length > 0;
        const hasKindFilter = kindFilter.trim().length > 0;
        const hasStatusFilter = statusFilter.trim().length > 0;
        const usePerGroupCap = !hasSearch && !hasKindFilter && !hasStatusFilter;
        const response = await getRuns(search, kindFilter, statusFilter, {
          initial: usePerGroupCap,
          limitPerGroup: 20,
        });
        if (!cancelled) {
          const nextSignature = buildRunsSignature(response.runs);
          if (runsSignatureRef.current !== nextSignature) {
            runsSignatureRef.current = nextSignature;
            setRuns(response.runs);
          }
          runsLoadedRef.current = true;
        }
      } catch (error) {
        if (!cancelled) {
          setRunsError(error instanceof Error ? error.message : String(error));
        }
      } finally {
        if (!cancelled) {
          setRunsLoading(false);
        }
      }
    }
    void refreshRuns();
    return () => {
      cancelled = true;
    };
  }, [search, kindFilter, statusFilter, dashboardRefreshToken]);

  useEffect(() => {
    if (!showRunDeleteModal) {
      return;
    }
    if (!runDeleteCriteria) {
      setRunDeletePreviewCount(null);
      setRunDeletePreviewBusy(false);
      setRunDeleteError(null);
      return;
    }
    let cancelled = false;
    setRunDeletePreviewBusy(true);
    setRunDeletePreviewCount(null);
    setRunDeleteError(null);
    void previewRunLogDelete(runDeleteCriteria)
      .then((response) => {
        if (!cancelled) {
          setRunDeletePreviewCount(response.matchCount);
        }
      })
      .catch((error) => {
        if (!cancelled) {
          setRunDeletePreviewCount(null);
          setRunDeleteError(error instanceof Error ? error.message : String(error));
        }
      })
      .finally(() => {
        if (!cancelled) {
          setRunDeletePreviewBusy(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [showRunDeleteModal, runDeleteMode, runDeleteType, runDeleteCountInput, runDeleteBeforeDate]);

  useEffect(() => {
    if (!selectedRunId) {
      setSelectedRunDetail(null);
      return;
    }
    let cancelled = false;
    void getRunDetail(selectedRunId)
      .then((detail) => {
        if (!cancelled) {
          setSelectedRunDetail(detail);
        }
      })
      .catch((error) => {
        if (!cancelled) {
          setRunsError(error instanceof Error ? error.message : String(error));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [selectedRunId]);

  useEffect(() => {
    let cancelled = false;
    async function refreshMetrics() {
      try {
        const [response, idleSummaryResponse] = await Promise.all([
          getMetrics(),
          getIdleSummary(40),
        ]);
        if (!cancelled) {
          setMetrics(response.days);
          setTaskMetrics(Array.isArray(response.taskDays) ? response.taskDays : []);
          setToolMetrics(response.toolStats || null);
          setIdleSummarySnapshots(idleSummaryResponse.snapshots);
          setMetricsError(null);
        }
      } catch (error) {
        if (!cancelled) {
          setMetricsError(error instanceof Error ? error.message : String(error));
        }
      }
    }
    void refreshMetrics();
    return () => {
      cancelled = true;
    };
  }, [dashboardRefreshToken]);

  useEffect(() => {
    let cancelled = false;
    async function refreshBenchmarkData() {
      setBenchmarkLoading(true);
      setBenchmarkError(null);
      try {
        const [presetResponse, sessionResponse] = await Promise.all([
          getBenchmarkQuestionPresets(),
          getBenchmarkSessions(50),
        ]);
        if (cancelled) {
          return;
        }
        setBenchmarkQuestionPresets(presetResponse.presets);
        setBenchmarkSessions(sessionResponse.sessions);
        setSelectedBenchmarkQuestionPresetIds((previous) => (
          previous.length > 0 ? previous : presetResponse.presets.filter((preset) => preset.enabled).slice(0, 3).map((preset) => preset.id)
        ));
        const nextSelectedSessionId = selectedBenchmarkSessionId || sessionResponse.sessions[0]?.id || '';
        if (nextSelectedSessionId && nextSelectedSessionId !== selectedBenchmarkSessionId) {
          setSelectedBenchmarkSessionId(nextSelectedSessionId);
        }
      } catch (error) {
        if (!cancelled) {
          setBenchmarkError(error instanceof Error ? error.message : String(error));
        }
      } finally {
        if (!cancelled) {
          setBenchmarkLoading(false);
        }
      }
    }
    if (tab === 'benchmark') {
      void refreshBenchmarkData();
    }
    return () => {
      cancelled = true;
    };
  }, [tab, dashboardRefreshToken]);

  useEffect(() => {
    if (!selectedBenchmarkSessionId) {
      setSelectedBenchmarkSession(null);
      setBenchmarkAttempts([]);
      return;
    }
    let cancelled = false;
    void getBenchmarkSession(selectedBenchmarkSessionId)
      .then((detail) => {
        if (!cancelled) {
          setSelectedBenchmarkSession(detail.session);
          setBenchmarkAttempts(detail.attempts);
        }
      })
      .catch((error) => {
        if (!cancelled) {
          setBenchmarkError(error instanceof Error ? error.message : String(error));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [selectedBenchmarkSessionId, dashboardRefreshToken]);

  useEffect(() => {
    if (!selectedBenchmarkSessionId || selectedBenchmarkSession?.status !== 'running') {
      return;
    }
    return openBenchmarkSessionEvents(selectedBenchmarkSessionId, (eventName, payload) => {
      if (eventName === 'log' && payload && typeof payload === 'object') {
        const text = String((payload as { text?: unknown }).text || '');
        if (text) {
          setBenchmarkLiveLogLines((previous) => [...previous, text.trimEnd()].slice(-200));
        }
      }
      if (eventName === 'attempt' || eventName === 'session' || eventName === 'done') {
        requestDashboardDataRefresh();
      }
      if (eventName === 'error' && payload && typeof payload === 'object') {
        setBenchmarkError(String((payload as { error?: unknown }).error || 'Benchmark stream error.'));
      }
    });
  }, [selectedBenchmarkSessionId, selectedBenchmarkSession?.status]);

  useEffect(() => {
    if (benchmarkManagedPresets.length === 0) {
      return;
    }
    setSelectedBenchmarkManagedPresetIds((previous) => (
      previous.length > 0 || !benchmarkManagedPresets[0] ? previous : [benchmarkManagedPresets[0].id]
    ));
  }, [benchmarkManagedPresets]);

  useEffect(() => {
    if (tab !== 'settings' && dashboardConfig !== null) {
      return;
    }
    let cancelled = false;
    async function refreshConfig() {
      setSettingsLoading(true);
      setSettingsError(null);
      try {
        const response = await getDashboardConfig();
        if (!cancelled) {
          const synced = cloneDashboardConfig(response);
          setDashboardConfig(synced);
          setSavedDashboardConfig(cloneDashboardConfig(synced));
        }
      } catch (error) {
        if (!cancelled) {
          setSettingsError(error instanceof Error ? error.message : String(error));
        }
      } finally {
        if (!cancelled) {
          setSettingsLoading(false);
        }
      }
    }
    void refreshConfig();
    return () => {
      cancelled = true;
    };
  }, [tab]);

  useEffect(() => {
    setSelectedSettingsPresetId((previous) => getFallbackPresetId(dashboardConfig?.Presets ?? [], previous));
  }, [dashboardConfig]);

  function updateSettingsDraft(updater: (next: DashboardConfig) => void): void {
    setDashboardConfig((previous) => {
      if (!previous) {
        return previous;
      }
      const next = cloneDashboardConfig(previous);
      updater(next);
      return syncDerivedSettingsFields(next);
    });
    setSettingsSavedAtUtc(null);
  }

  function updatePresetDraft(presetId: string, updater: (preset: DashboardPreset) => void): void {
    updateSettingsDraft((next) => {
      const preset = next.Presets.find((entry) => entry.id === presetId);
      if (!preset) {
        return;
      }
      updater(preset);
    });
  }

  function updateManagedLlamaDraft(updater: (preset: DashboardManagedLlamaPreset) => void): void {
    updateSettingsDraft((next) => {
      updateActiveManagedLlamaPreset(next, updater);
    });
  }

  function createUniquePresetId(existingPresets: DashboardPreset[], label: string): string {
    const baseId = createPresetIdFromLabel(label);
    if (!existingPresets.some((preset) => preset.id === baseId)) {
      return baseId;
    }
    let counter = 2;
    while (existingPresets.some((preset) => preset.id === `${baseId}-${counter}`)) {
      counter += 1;
    }
    return `${baseId}-${counter}`;
  }

  function onAddPreset(): void {
    let addedPresetId: string | null = null;
    updateSettingsDraft((next) => {
      const id = createUniquePresetId(next.Presets, `custom-preset-${next.Presets.length + 1}`);
      addedPresetId = id;
      next.Presets.push({
        id,
        label: `Custom Preset ${Math.max(1, next.Presets.filter((preset) => preset.deletable).length + 1)}`,
        description: '',
        presetKind: 'summary',
        operationMode: 'summary',
        executionFamily: 'summary',
        promptPrefix: '',
        allowedTools: getDefaultToolsForOperationMode('summary'),
        surfaces: ['cli'],
        useForSummary: false,
        builtin: false,
        deletable: true,
        includeAgentsMd: true,
        includeRepoFileListing: true,
        repoRootRequired: false,
        maxTurns: null,
      });
    });
    setSelectedSettingsPresetId(addedPresetId);
  }

  function onDeletePreset(presetId: string): void {
    let nextPresetId: string | null = null;
    updateSettingsDraft((next) => {
      nextPresetId = getNextPresetIdAfterDelete(next.Presets, presetId);
      next.Presets = next.Presets.filter((preset) => preset.id !== presetId || preset.deletable === false);
    });
    setSelectedSettingsPresetId(nextPresetId);
  }

  function onAddManagedLlamaPreset(): void {
    updateSettingsDraft((next) => {
      addManagedLlamaPreset(next);
    });
  }

  function onDeleteManagedLlamaPreset(presetId: string): void {
    updateSettingsDraft((next) => {
      deleteManagedLlamaPreset(next, presetId);
    });
  }

  async function refreshAfterChatMessageMutation(): Promise<void> {
    requestDashboardDataRefresh();
    if (selectedRunId) {
      try {
        const detail = await getRunDetail(selectedRunId);
        setSelectedRunDetail(detail);
      } catch (error) {
        setChatError(describeStreamError(error));
      }
    }
  }

  async function onDeleteChatMessage(messageId: string): Promise<void> {
    const response = await chatSessionsHook.deleteMessage(messageId);
    if (!response) {
      return;
    }
    await refreshAfterChatMessageMutation();
  }

  async function onDeleteChatTurn(messageIds: string[]): Promise<void> {
    const response = await chatSessionsHook.deleteMessages(messageIds);
    if (!response) {
      return;
    }
    await refreshAfterChatMessageMutation();
  }

  async function saveDashboardSettingsCore(): Promise<boolean> {
    if (!dashboardConfig) {
      return false;
    }
    setSettingsSaving(true);
    setSettingsError(null);
    try {
      const updated = await updateDashboardConfig(dashboardConfig);
      const synced = cloneDashboardConfig(updated);
      setDashboardConfig(synced);
      setSavedDashboardConfig(cloneDashboardConfig(synced));
      setSettingsSavedAtUtc(new Date().toISOString());
      return true;
    } catch (error) {
      setSettingsError(error instanceof Error ? error.message : String(error));
      return false;
    } finally {
      setSettingsSaving(false);
    }
  }

  async function onSaveDashboardSettings(): Promise<void> {
    await saveDashboardSettingsCore();
  }

  async function reloadDashboardSettingsCore(): Promise<boolean> {
    setSettingsLoading(true);
    setSettingsError(null);
    try {
      const response = await getDashboardConfig();
      const synced = cloneDashboardConfig(response);
      setDashboardConfig(synced);
      setSavedDashboardConfig(cloneDashboardConfig(synced));
      setSettingsSavedAtUtc(null);
      return true;
    } catch (error) {
      setSettingsError(error instanceof Error ? error.message : String(error));
      return false;
    } finally {
      setSettingsLoading(false);
    }
  }

  async function onReloadDashboardSettings(): Promise<void> {
    await reloadDashboardSettingsCore();
  }

  async function onPickManagedLlamaPath(target: 'ExecutablePath' | 'ModelPath'): Promise<void> {
    if (!dashboardConfig || !selectedManagedLlamaPreset) {
      return;
    }
    const initialPath = target === 'ExecutablePath'
      ? selectedManagedLlamaPreset.ExecutablePath
      : selectedManagedLlamaPreset.ModelPath;
    setSettingsPathPickerBusyTarget(target);
    setSettingsError(null);
    try {
      const response = await pickManagedFile(
        target === 'ExecutablePath' ? 'managed-llama-executable' : 'managed-llama-model',
        initialPath,
      );
      if (response.cancelled || !response.path) {
        return;
      }
      updateManagedLlamaDraft((preset) => {
        if (target === 'ExecutablePath') {
          preset.ExecutablePath = response.path;
          return;
        }
        preset.ModelPath = response.path;
        preset.Model = deriveRuntimeModelId(preset.ModelPath) || preset.Model;
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setSettingsError(message);
      enqueueToast('error', `Path picker failed: ${message}`);
    } finally {
      setSettingsPathPickerBusyTarget(null);
    }
  }

  function toggleBenchmarkQuestionPreset(id: string): void {
    setSelectedBenchmarkQuestionPresetIds((previous) => (
      previous.includes(id) ? previous.filter((entry) => entry !== id) : [...previous, id]
    ));
  }

  function toggleBenchmarkManagedPreset(id: string): void {
    setSelectedBenchmarkManagedPresetIds((previous) => (
      previous.includes(id) ? previous.filter((entry) => entry !== id) : [...previous, id]
    ));
  }

  async function onStartBenchmark(): Promise<void> {
    setBenchmarkStarting(true);
    setBenchmarkError(null);
    setBenchmarkLiveLogLines([]);
    try {
      const response = await startBenchmarkSession({
        questionPresetIds: selectedBenchmarkQuestionPresetIds,
        managedPresetIds: selectedBenchmarkManagedPresetIds,
        repetitions: benchmarkRepetitions,
        specOverrides: [{ label: benchmarkSpecOverrideLabel }],
      });
      setSelectedBenchmarkSessionId(response.session.id);
      setSelectedBenchmarkSession(response.session);
      setBenchmarkAttempts(response.attempts);
      enqueueToast('info', 'Benchmark started.');
    } catch (error) {
      setBenchmarkError(error instanceof Error ? error.message : String(error));
    } finally {
      setBenchmarkStarting(false);
    }
  }

  async function onCancelBenchmark(sessionId: string): Promise<void> {
    setBenchmarkCancelling(true);
    setBenchmarkError(null);
    try {
      await cancelBenchmarkSession(sessionId);
      requestDashboardDataRefresh();
      enqueueToast('warning', 'Benchmark cancellation requested.');
    } catch (error) {
      setBenchmarkError(error instanceof Error ? error.message : String(error));
    } finally {
      setBenchmarkCancelling(false);
    }
  }

  async function onUpdateBenchmarkAttemptGrade(
    attemptId: string,
    outputQualityScore: number | null,
    toolUseQualityScore: number | null,
    reviewNotes: string | null,
  ): Promise<void> {
    try {
      const response = await updateBenchmarkAttemptGrade(attemptId, {
        outputQualityScore,
        toolUseQualityScore,
        reviewNotes,
        reviewedBy: 'codex',
      });
      setBenchmarkAttempts((previous) => previous.map((attempt) => (
        attempt.id === response.attempt.id ? response.attempt : attempt
      )));
    } catch (error) {
      setBenchmarkError(error instanceof Error ? error.message : String(error));
    }
  }

  async function onTestLlamaCppBaseUrl(baseUrl: string, timeoutMs: number): Promise<void> {
    setSettingsError(null);
    try {
      const response = await testLlamaCppBaseUrlRequest(baseUrl, timeoutMs);
      if (!response.ok) {
        throw new Error(response.error || `llama.cpp test failed with status ${response.statusCode}`);
      }
      setSettingsSavedAtUtc(new Date().toISOString());
      enqueueToast('info', `llama.cpp reachable at ${response.baseUrl || baseUrl}.`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setSettingsError(message);
      enqueueToast('error', `llama.cpp test failed: ${message}`);
    }
  }

  function discardDashboardSettingsChanges(): void {
    if (!savedDashboardConfig) {
      return;
    }
    setDashboardConfig(cloneDashboardConfig(savedDashboardConfig));
    setSettingsError(null);
  }

  async function restartDashboardBackendCore(): Promise<boolean> {
    setSettingsRestarting(true);
    setSettingsError(null);
    setSettingsRestartFailureModal(null);
    try {
      const response = await restartBackend();
      if (!response.ok || !response.restarted) {
        const message = response.error || 'Backend restart failed.';
        const modal = buildManagedLlamaRestartFailureModal(response);
        setSettingsError(message);
        if (modal) {
          setSettingsRestartFailureModal(modal);
        }
        enqueueToast('error', `Backend restart failed: ${message}`);
        return false;
      }
      await getDashboardHealth();
      const reloaded = await reloadDashboardSettingsCore();
      if (reloaded) {
        enqueueToast('info', 'Backend restarted.');
      }
      return reloaded;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setSettingsError(message);
      enqueueToast('error', `Backend restart failed: ${message}`);
      return false;
    } finally {
      setSettingsRestarting(false);
    }
  }

  async function continueSettingsAction(continuation: DirtyContinuation): Promise<void> {
    if (continuation.kind === 'switch-section') {
      setActiveSettingsSection(continuation.nextSection);
      return;
    }
    if (continuation.kind === 'switch-tab') {
      setTab(continuation.nextTab);
      setMenuOpen(false);
      return;
    }
    if (continuation.kind === 'reload-settings') {
      await reloadDashboardSettingsCore();
      return;
    }
    await restartDashboardBackendCore();
  }

  function closeSettingsConfirm(): void {
    setShowSettingsConfirm(false);
    setPendingSettingsContinuation(null);
  }

  function requestSettingsAction(continuation: DirtyContinuation): void {
    if (getDirtyActionRequirement(settingsDirty, continuation.kind) === 'confirm') {
      setPendingSettingsContinuation(continuation);
      setShowSettingsConfirm(true);
      return;
    }
    void continueSettingsAction(continuation);
  }

  async function onConfirmSaveSettingsAction(): Promise<void> {
    if (!pendingSettingsContinuation) {
      return;
    }
    const continuation = pendingSettingsContinuation;
    const saved = await saveDashboardSettingsCore();
    if (!saved) {
      return;
    }
    closeSettingsConfirm();
    await continueSettingsAction(continuation);
  }

  function onConfirmDiscardSettingsAction(): void {
    if (!pendingSettingsContinuation) {
      return;
    }
    const continuation = pendingSettingsContinuation;
    discardDashboardSettingsChanges();
    closeSettingsConfirm();
    void continueSettingsAction(continuation);
  }

  function onRequestTabChange(nextTab: TabKey): void {
    if (tab === 'settings' && nextTab !== 'settings') {
      requestSettingsAction({ kind: 'switch-tab', nextTab });
      return;
    }
    setTab(nextTab);
    setMenuOpen(false);
  }

  useEffect(() => {
    const handleBeforeUnload = (event: BeforeUnloadEvent): void => {
      if (tab !== 'settings' || !settingsDirty) {
        return;
      }
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => {
      window.removeEventListener('beforeunload', handleBeforeUnload);
    };
  }, [settingsDirty, tab]);

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="topbar-menu">
          <button
            type="button"
            className="hamburger-button"
            aria-label="Open sections menu"
            onClick={() => setMenuOpen((previous) => !previous)}
          >
            <span />
            <span />
            <span />
          </button>
          {menuOpen ? (
            <div className="menu-popover">
              <button
                className={tab === 'runs' ? 'active' : ''}
                onClick={() => onRequestTabChange('runs')}
              >
                Logs
              </button>
              <button
                className={tab === 'metrics' ? 'active' : ''}
                onClick={() => onRequestTabChange('metrics')}
              >
                Metrics
              </button>
              <button
                className={tab === 'benchmark' ? 'active' : ''}
                onClick={() => onRequestTabChange('benchmark')}
              >
                Benchmark
              </button>
              <button
                className={tab === 'chat' ? 'active' : ''}
                onClick={() => onRequestTabChange('chat')}
              >
                Chat
              </button>
              <button
                className={tab === 'settings' ? 'active' : ''}
                onClick={() => onRequestTabChange('settings')}
              >
                Settings
              </button>
            </div>
          ) : null}
        </div>
        <h1>SiftKit Local Dashboard</h1>
        <button
          type="button"
          className="topbar-refresh-button"
          onClick={requestDashboardDataRefresh}
          aria-label="Refresh dashboard data"
        >
          Refresh data
        </button>
      </header>

      {toasts.length > 0 && (
        <section className="toast-stack" aria-live="polite" aria-atomic="true">
          {toasts.map((toast) => (
            <article key={toast.id} className={`toast ${toast.level}`}>
              <span>{toast.text}</span>
              <button
                type="button"
                className="toast-dismiss"
                onClick={() => dismissToast(toast.id)}
                aria-label="Dismiss notification"
              >
                x
              </button>
            </article>
          ))}
        </section>
      )}

      {showSettingsConfirm && (
        <section className="settings-live-modal-backdrop" role="presentation">
          <div className="settings-live-modal" role="dialog" aria-modal="true" aria-labelledby="settings-confirm-title">
            <h2 id="settings-confirm-title">Unsaved settings changes</h2>
            <p className="hint">Save the current settings draft before continuing, discard the unsaved changes, or cancel and stay on this section.</p>
            <div className="settings-live-modal-actions">
              <button type="button" onClick={() => { void onConfirmSaveSettingsAction(); }} disabled={settingsActionBusy}>
                {settingsSaving ? 'Saving...' : 'Save'}
              </button>
              <button type="button" onClick={onConfirmDiscardSettingsAction} disabled={settingsActionBusy}>
                Discard
              </button>
              <button type="button" onClick={closeSettingsConfirm} disabled={settingsActionBusy}>
                Cancel
              </button>
            </div>
          </div>
        </section>
      )}

      {settingsRestartFailureModal && (
        <section className="settings-live-modal-backdrop" role="presentation">
          <div className="settings-live-modal" role="dialog" aria-modal="true" aria-labelledby="settings-restart-failure-title">
            <h2 id="settings-restart-failure-title">{settingsRestartFailureModal.title}</h2>
            <p>{settingsRestartFailureModal.message}</p>
            <div className="settings-live-modal-actions">
              <button type="button" onClick={() => setSettingsRestartFailureModal(null)} disabled={settingsActionBusy}>
                Close
              </button>
            </div>
          </div>
        </section>
      )}

      {showRunDeleteModal && (
        <section className="settings-live-modal-backdrop" role="presentation">
          <div className="run-delete-modal" role="dialog" aria-modal="true" aria-labelledby="run-delete-title">
            <div className="run-delete-header">
              <div>
                <h2 id="run-delete-title">Delete logs</h2>
                <p className="hint">Preview the matching logs first, then permanently remove them from the dashboard database.</p>
              </div>
              <button type="button" className="run-delete-close" onClick={closeRunDeleteModal} disabled={runDeleteBusy} aria-label="Close delete logs dialog">
                x
              </button>
            </div>

            <div className="run-delete-mode-row">
              <button
                type="button"
                className={runDeleteMode === 'count' ? 'active' : ''}
                onClick={() => setRunDeleteMode('count')}
                disabled={runDeleteBusy}
              >
                Delete Oldest N
              </button>
              <button
                type="button"
                className={runDeleteMode === 'before_date' ? 'active' : ''}
                onClick={() => setRunDeleteMode('before_date')}
                disabled={runDeleteBusy}
              >
                Delete Before Date
              </button>
            </div>

            <div className="filter-pill-row">
              <span className="filter-pill-label">Type</span>
              {RUN_LOG_TYPE_PRESETS.map((preset) => (
                <button
                  key={preset.deleteValue}
                  type="button"
                  className={`filter-pill kind ${preset.tone} ${runDeleteType === preset.deleteValue ? 'active' : ''}`}
                  onClick={() => setRunDeleteType(preset.deleteValue)}
                  disabled={runDeleteBusy}
                >
                  {preset.label}
                </button>
              ))}
            </div>

            <div className="run-delete-fields">
              {runDeleteMode === 'count' ? (
                <label>
                  <span>Delete oldest matching logs</span>
                  <input
                    type="number"
                    min="1"
                    step="1"
                    value={runDeleteCountInput}
                    onChange={(event) => setRunDeleteCountInput(event.target.value)}
                    disabled={runDeleteBusy}
                  />
                </label>
              ) : (
                <label>
                  <span>Delete logs older than</span>
                  <input
                    type="date"
                    value={runDeleteBeforeDate}
                    onChange={(event) => setRunDeleteBeforeDate(event.target.value)}
                    disabled={runDeleteBusy}
                  />
                </label>
              )}
            </div>

            <div className={`run-delete-preview ${runDeletePreviewCount === 0 ? 'empty' : 'ready'}`}>
              <strong>{runDeleteSummary || 'Choose valid delete criteria'}</strong>
              <span className="hint">
                {runDeletePreviewBusy
                  ? 'Checking matching logs...'
                  : runDeleteCriteria && runDeletePreviewCount !== null
                    ? `${runDeletePreviewCount} matching ${runDeletePreviewCount === 1 ? 'log' : 'logs'} found.`
                    : 'Enter a count or date to preview the delete scope.'}
              </span>
            </div>

            {runDeleteError && <p className="error">{runDeleteError}</p>}

            <div className="run-delete-modal-actions">
              <button type="button" onClick={closeRunDeleteModal} disabled={runDeleteBusy}>
                Cancel
              </button>
              <button
                type="button"
                className="danger-button"
                onClick={() => { void handleConfirmRunDelete(); }}
                disabled={runDeleteBusy || runDeletePreviewBusy || !runDeleteCriteria || runDeletePreviewCount === null || runDeletePreviewCount < 1}
              >
                {runDeleteBusy ? 'Deleting...' : runDeleteSummary || 'Delete Logs'}
              </button>
            </div>
          </div>
        </section>
      )}

      {tab === 'runs' && (
        <RunsTab
          search={search}
          statusFilter={statusFilter}
          kindFilter={kindFilter}
          runsLoading={runsLoading}
          runsError={runsError}
          groupedRuns={groupedRuns}
          selectedRunId={selectedRunId}
          selectedRunDetail={selectedRunDetail}
          isRepoSearchRunSelected={isRepoSearchRunSelected}
          repoSearchSimpleFlow={repoSearchSimpleFlow}
          repoSearchChatSteps={repoSearchChatSteps}
          onChangeSearch={setSearch}
          onOpenRunDeleteModal={openRunDeleteModal}
          onChangeStatusFilter={setStatusFilter}
          onToggleKindFilter={(value) => setKindFilter((previous) => toggleRunLogTypeFilter(previous, value))}
          onSelectRun={setSelectedRunId}
          onChangeRepoSearchSimpleFlow={setRepoSearchSimpleFlow}
        />
      )}

      {tab === 'metrics' && (
        <>
          {metricsError && <p className="error">{metricsError}</p>}
          <MetricsTab
            metrics={metrics}
            idleSummarySnapshots={idleSummarySnapshots}
            recentIdlePoints={recentIdlePoints}
            latestIdleSnapshot={latestIdleSnapshot}
            sortedToolMetricRows={sortedToolMetricRows}
            taskRunsGraphSeries={taskRunsGraphSeries}
          />
        </>
      )}
      {tab === 'benchmark' && (
        <BenchmarkTab
          questionPresets={benchmarkQuestionPresets}
          sessions={benchmarkSessions}
          selectedSession={selectedBenchmarkSession}
          attempts={sortedBenchmarkAttempts}
          liveLogLines={benchmarkLiveLogLines}
          managedPresets={benchmarkManagedPresets}
          selectedQuestionPresetIds={selectedBenchmarkQuestionPresetIds}
          selectedManagedPresetIds={selectedBenchmarkManagedPresetIds}
          repetitions={benchmarkRepetitions}
          specOverrideLabel={benchmarkSpecOverrideLabel}
          loading={benchmarkLoading}
          error={benchmarkError}
          starting={benchmarkStarting}
          cancelling={benchmarkCancelling}
          sortKey={benchmarkSortKey}
          onToggleQuestionPreset={toggleBenchmarkQuestionPreset}
          onToggleManagedPreset={toggleBenchmarkManagedPreset}
          onRepetitionsChange={(value) => setBenchmarkRepetitions(Math.max(1, Math.trunc(Number(value) || 1)))}
          onSpecOverrideLabelChange={setBenchmarkSpecOverrideLabel}
          onStartBenchmark={onStartBenchmark}
          onCancelBenchmark={onCancelBenchmark}
          onSortChange={setBenchmarkSortKey}
          onSelectSession={setSelectedBenchmarkSessionId}
          onUpdateAttemptGrade={onUpdateBenchmarkAttemptGrade}
        />
      )}
      {tab === 'settings' && (
        <SettingsTab
          activeSettingsSection={activeSettingsSection}
          dashboardConfig={dashboardConfig}
          selectedSettingsPreset={selectedSettingsPreset}
          selectedManagedLlamaPreset={selectedManagedLlamaPreset}
          selectedSettingsPresetId={selectedSettingsPresetId}
          settingsLoading={settingsLoading}
          settingsError={settingsError}
          settingsDirty={settingsDirty}
          settingsSavedAtUtc={settingsSavedAtUtc}
          settingsActionBusy={settingsActionBusy}
          settingsRestartSupported={settingsRestartSupported}
          settingsSaving={settingsSaving}
          settingsRestarting={settingsRestarting}
          settingsPathPickerBusyTarget={settingsPathPickerBusyTarget}
          setSelectedSettingsPresetId={setSelectedSettingsPresetId}
          requestSettingsAction={requestSettingsAction}
          updateSettingsDraft={updateSettingsDraft}
          updatePresetDraft={updatePresetDraft}
          updateManagedLlamaDraft={updateManagedLlamaDraft}
          onAddPreset={onAddPreset}
          onDeletePreset={onDeletePreset}
          onAddManagedLlamaPreset={onAddManagedLlamaPreset}
          onDeleteManagedLlamaPreset={onDeleteManagedLlamaPreset}
          onPickManagedLlamaPath={onPickManagedLlamaPath}
          onTestLlamaCppBaseUrl={onTestLlamaCppBaseUrl}
          onReloadDashboardSettings={onReloadDashboardSettings}
          restartDashboardBackendCore={restartDashboardBackendCore}
          onSaveDashboardSettings={onSaveDashboardSettings}
        />
      )}

      {tab === 'chat' && (
        <ChatTab
          sessions={chatSessionsHook.sessions}
          selectedSessionId={chatSessionsHook.selectedSessionId}
          selectedSession={selectedSession}
          sessionPromptCacheStats={sessionPromptCacheStats}
          webPresets={webPresets}
          selectedChatPreset={selectedChatPreset}
          chatMode={chatMode}
          isDirectChatMode={isDirectChatMode}
          isRepoToolMode={isRepoToolMode}
          isThinkingEnabledForCurrentSession={isThinkingEnabledForCurrentSession}
          webSearchEnabled={selectedSession?.webSearchEnabled === true}
          showSettings={showSettings}
          planRepoRootInput={planInputs.planRepoRootInput}
          contextUsage={contextHook.contextUsage}
          liveToolPromptTokenCount={contextHook.liveToolPromptTokenCount}
          repoSearchAutoAppendPreview={autoAppend.preview}
          repoSearchAutoAppendSelection={autoAppend.selection}
          isRepoSearchAutoAppendPreviewLoading={autoAppend.previewLoading}
          liveMessages={live.liveMessages}
          chatInput={composer.chatInput}
          chatBusy={chatSessionsHook.chatBusy}
          chatError={chatError}
          onSelectSession={chatSessionsHook.selectSession}
          onToggleSettings={() => setShowSettings((prev) => !prev)}
          onChangePlanRepoRoot={planInputs.setPlanRepoRootInput}
          onChangeChatInput={composer.setChatInput}
          onSetRepoSearchAutoAppendSelection={autoAppend.setSelection}
          onCreateSession={chatSessionsHook.createSession}
          onDeleteSession={chatSessionsHook.deleteSession}
          onUpdateSessionPreset={chatSessionsHook.updateSessionPreset}
          onToggleThinking={chatSessionsHook.toggleThinking}
          onToggleWebSearchEnabled={chatSessionsHook.toggleWebSearch}
          onSavePlanRepoRoot={() => chatSessionsHook.savePlanRepoRoot(planInputs.planRepoRootInput, selectedChatPreset?.id)}
          onClearToolContext={chatSessionsHook.clearToolContext}
          onDeleteMessage={onDeleteChatMessage}
          onDeleteTurn={onDeleteChatTurn}
          onCondense={chatSessionsHook.condense}
          onSendPlan={composer.sendPlan}
          onSendRepoSearch={composer.sendRepoSearch}
          onSendMessage={composer.sendMessage}
        />
      )}
    </main>
  );
}

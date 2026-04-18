import { useEffect, useRef, useState } from 'react';
import {
  clearToolContext,
  condenseChatSession,
  createPlanMessage,
  streamPlanMessage,
  createChatSession,
  deleteRunLogs,
  deleteChatSession,
  getDashboardConfig,
  getDashboardHealth,
  getChatSession,
  getChatSessions,
  getIdleSummary,
  getMetrics,
  pickManagedFile,
  getRunDetail,
  getRuns,
  previewRunLogDelete,
  restartBackend,
  streamChatMessage,
  streamRepoSearchMessage,
  updateDashboardConfig,
  updateChatSession,
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
import { syncDerivedSettingsFields } from './settings-runtime';
import { SettingsMockupPage } from './settings-mockup';
import { buildTaskRunsSeries, buildToolMetricRows } from './metrics-view';
import type { InteractiveSeries } from './components/InteractiveGraph';
import { buildRepoSearchChatSteps } from './lib/chat-steps';
import {
  buildRunsSignature,
  classifyRunGroup,
  cloneDashboardConfig,
  getDashboardConfigSignature,
  getSessionPromptCacheStats,
  readSearchParams,
  writeSearchParams,
} from './lib/format';
import { RunsTab } from './tabs/RunsTab';
import { MetricsTab } from './tabs/MetricsTab';
import { ChatTab, type ChatToolCall } from './tabs/ChatTab';
import { SettingsTab } from './tabs/SettingsTab';
import type { ChatSession, ContextUsage, DashboardConfig, DashboardManagedLlamaPreset, DashboardPreset, IdleSummarySnapshot, MetricDay, RunGroupFilter, TaskMetricDay, ToolStatsByTask, RunDetailResponse, RunLogDeleteType, RunRecord } from './types';

type TabKey = 'runs' | 'metrics' | 'chat' | 'settings';
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
  const [runsReloadToken, setRunsReloadToken] = useState(0);
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

  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [selectedSessionId, setSelectedSessionId] = useState(params.get('session') || '');
  const [selectedSession, setSelectedSession] = useState<ChatSession | null>(null);
  const [contextUsage, setContextUsage] = useState<ContextUsage | null>(null);
  const [chatInput, setChatInput] = useState('');
  const [chatError, setChatError] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [chatBusy, setChatBusy] = useState(false);
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
  const [thinkingDraft, setThinkingDraft] = useState('');
  const [answerDraft, setAnswerDraft] = useState('');
  const [planRepoRootInput, setPlanRepoRootInput] = useState('');
  const [planMaxTurnsInput, setPlanMaxTurnsInput] = useState('45');
  const [planToolCalls, setPlanToolCalls] = useState<ChatToolCall[]>([]);
  const [liveToolPromptTokenCount, setLiveToolPromptTokenCount] = useState<number | null>(null);

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

  function requestRunsRefresh(): void {
    runsSignatureRef.current = '';
    runsLoadedRef.current = false;
    setRunsReloadToken((previous) => previous + 1);
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
      requestRunsRefresh();
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
  const sessionPromptCacheStats = getSessionPromptCacheStats(selectedSession);
  const settingsDirty = dashboardConfig !== null
    && savedDashboardConfig !== null
    && getDashboardConfigSignature(dashboardConfig) !== getDashboardConfigSignature(savedDashboardConfig);
  const settingsActionBusy = settingsLoading || settingsSaving || settingsRestarting || settingsPathPickerBusyTarget !== null;
  const settingsRestartSupported = dashboardConfig?.Backend === 'llama.cpp';
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
      session: selectedSessionId || null,
    });
  }, [tab, search, kindFilter, statusFilter, selectedRunId, selectedSessionId]);

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
    const handle = window.setInterval(() => { void refreshRuns(); }, 2500);
    return () => {
      cancelled = true;
      window.clearInterval(handle);
    };
  }, [search, kindFilter, statusFilter, runsReloadToken]);

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
    const handle = window.setInterval(() => { void refreshMetrics(); }, 3000);
    return () => {
      cancelled = true;
      window.clearInterval(handle);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    async function refreshSessions() {
      try {
        const response = await getChatSessions();
        if (!cancelled) {
          setSessions(response.sessions);
          if (!selectedSessionId) {
            const firstSession = response.sessions[0];
            if (firstSession) {
              setSelectedSessionId(firstSession.id);
            }
          }
        }
      } catch (error) {
        if (!cancelled) {
          setChatError(error instanceof Error ? error.message : String(error));
        }
      }
    }
    void refreshSessions();
    const handle = window.setInterval(() => { void refreshSessions(); }, 3000);
    return () => {
      cancelled = true;
      window.clearInterval(handle);
    };
  }, [selectedSessionId]);

  useEffect(() => {
    if (!selectedSessionId) {
      setSelectedSession(null);
      setContextUsage(null);
      return;
    }
    let cancelled = false;
    void getChatSession(selectedSessionId)
      .then((response) => {
        if (!cancelled) {
          setSelectedSession(response.session);
          setContextUsage(response.contextUsage);
        }
      })
      .catch((error) => {
        if (!cancelled) {
          setChatError(error instanceof Error ? error.message : String(error));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [selectedSessionId]);

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

  useEffect(() => {
    setPlanRepoRootInput(selectedSession?.planRepoRoot || '');
  }, [selectedSession?.id, selectedSession?.planRepoRoot]);

  useEffect(() => {
    if (!selectedChatPreset) {
      return;
    }
    if (selectedChatPreset.maxTurns !== null) {
      setPlanMaxTurnsInput(String(selectedChatPreset.maxTurns));
    }
  }, [selectedChatPreset?.id]);

  async function onCreateSession() {
    setChatBusy(true);
    setChatError(null);
    try {
      const response = await createChatSession({
        title: `Session ${new Date().toLocaleTimeString()}`,
        model: dashboardConfig?.Runtime.Model || 'Qwen3.5-9B-Q8_0.gguf',
        presetId: getDefaultWebPresetId(dashboardConfig),
      });
      setSessions((previous) => [response.session, ...previous]);
      setSelectedSessionId(response.session.id);
      setSelectedSession(response.session);
      setContextUsage(response.contextUsage);
    } catch (error) {
      setChatError(error instanceof Error ? error.message : String(error));
    } finally {
      setChatBusy(false);
    }
  }

  async function onSendMessage() {
    if (!selectedSessionId || !chatInput.trim()) {
      return;
    }
    setChatBusy(true);
    setChatError(null);
    setThinkingDraft('');
    setAnswerDraft('');
    try {
      const response = await streamChatMessage(selectedSessionId, {
        content: chatInput.trim(),
      }, (thinkingText) => {
        if (isThinkingEnabledForCurrentSession) {
          setThinkingDraft(thinkingText);
        }
      }, (answerText) => {
        setAnswerDraft(answerText);
      });
      setSelectedSession(response.session);
      setContextUsage(response.contextUsage);
      setChatInput('');
    } catch (error) {
      setChatError(error instanceof Error ? error.message : String(error));
    } finally {
      setThinkingDraft('');
      setAnswerDraft('');
      setChatBusy(false);
    }
  }

  async function onSendPlan() {
    if (!selectedSessionId || !chatInput.trim()) {
      return;
    }
    setChatBusy(true);
    setChatError(null);
    setThinkingDraft('');
    setAnswerDraft('');
    setPlanToolCalls([]);
    setLiveToolPromptTokenCount(null);
    try {
      const parsedMaxTurns = Number(planMaxTurnsInput);
      const response = await streamPlanMessage(
        selectedSessionId,
        {
          content: chatInput.trim(),
          repoRoot: planRepoRootInput.trim() || selectedSession?.planRepoRoot || '',
          ...(Number.isFinite(parsedMaxTurns) && parsedMaxTurns > 0 ? { maxTurns: parsedMaxTurns } : {}),
        },
        (thinkingText) => {
          setThinkingDraft(thinkingText);
        },
        (toolEvent) => {
          if (toolEvent.kind === 'tool_start') {
            if (typeof toolEvent.promptTokenCount === 'number') {
              setLiveToolPromptTokenCount(toolEvent.promptTokenCount);
            }
            setPlanToolCalls((prev) => [
              ...prev,
              {
                turn: toolEvent.turn,
                maxTurns: toolEvent.maxTurns,
                command: toolEvent.command,
                ...(typeof toolEvent.promptTokenCount === 'number' ? { promptTokenCount: toolEvent.promptTokenCount } : {}),
                status: 'running',
              },
            ]);
          } else if (toolEvent.kind === 'tool_result') {
            if (typeof toolEvent.promptTokenCount === 'number') {
              setLiveToolPromptTokenCount(toolEvent.promptTokenCount);
            }
            setPlanToolCalls((prev) => {
              const updated = [...prev];
              const last = updated.length > 0 ? updated[updated.length - 1] : null;
              if (last && last.command === toolEvent.command && last.status === 'running') {
                const entry: typeof last = { ...last, status: 'done' };
                if (typeof toolEvent.exitCode === 'number') { entry.exitCode = toolEvent.exitCode; }
                if (typeof toolEvent.outputSnippet === 'string') { entry.outputSnippet = toolEvent.outputSnippet; }
                if (typeof toolEvent.promptTokenCount === 'number') { entry.promptTokenCount = toolEvent.promptTokenCount; }
                updated[updated.length - 1] = entry;
              }
              return updated;
            });
          }
        },
        (answerText) => {
          setAnswerDraft(answerText);
        },
      );
      setSelectedSession(response.session);
      setContextUsage(response.contextUsage);
      setChatInput('');
    } catch (error) {
      setChatError(error instanceof Error ? error.message : String(error));
    } finally {
      setThinkingDraft('');
      setAnswerDraft('');
      setPlanToolCalls([]);
      setLiveToolPromptTokenCount(null);
      setChatBusy(false);
    }
  }

  async function onSendRepoSearch() {
    if (!selectedSessionId || !chatInput.trim()) {
      return;
    }
    setChatBusy(true);
    setChatError(null);
    setThinkingDraft('');
    setAnswerDraft('');
    setPlanToolCalls([]);
    setLiveToolPromptTokenCount(null);
    try {
      const parsedMaxTurnsRS = Number(planMaxTurnsInput);
      const response = await streamRepoSearchMessage(
        selectedSessionId,
        {
          content: chatInput.trim(),
          repoRoot: planRepoRootInput.trim() || selectedSession?.planRepoRoot || '',
          ...(Number.isFinite(parsedMaxTurnsRS) && parsedMaxTurnsRS > 0 ? { maxTurns: parsedMaxTurnsRS } : {}),
        },
        (thinkingText) => {
          setThinkingDraft(thinkingText);
        },
        (toolEvent) => {
          if (toolEvent.kind === 'tool_start') {
            if (typeof toolEvent.promptTokenCount === 'number') {
              setLiveToolPromptTokenCount(toolEvent.promptTokenCount);
            }
            setPlanToolCalls((prev) => [
              ...prev,
              {
                turn: toolEvent.turn,
                maxTurns: toolEvent.maxTurns,
                command: toolEvent.command,
                ...(typeof toolEvent.promptTokenCount === 'number' ? { promptTokenCount: toolEvent.promptTokenCount } : {}),
                status: 'running',
              },
            ]);
          } else if (toolEvent.kind === 'tool_result') {
            if (typeof toolEvent.promptTokenCount === 'number') {
              setLiveToolPromptTokenCount(toolEvent.promptTokenCount);
            }
            setPlanToolCalls((prev) => {
              const updated = [...prev];
              const last = updated.length > 0 ? updated[updated.length - 1] : null;
              if (last && last.command === toolEvent.command && last.status === 'running') {
                const entry: typeof last = { ...last, status: 'done' };
                if (typeof toolEvent.exitCode === 'number') { entry.exitCode = toolEvent.exitCode; }
                if (typeof toolEvent.outputSnippet === 'string') { entry.outputSnippet = toolEvent.outputSnippet; }
                if (typeof toolEvent.promptTokenCount === 'number') { entry.promptTokenCount = toolEvent.promptTokenCount; }
                updated[updated.length - 1] = entry;
              }
              return updated;
            });
          }
        },
        (answerText) => {
          setAnswerDraft(answerText);
        },
      );
      setSelectedSession(response.session);
      setContextUsage(response.contextUsage);
      setChatInput('');
    } catch (error) {
      setChatError(error instanceof Error ? error.message : String(error));
    } finally {
      setThinkingDraft('');
      setAnswerDraft('');
      setPlanToolCalls([]);
      setLiveToolPromptTokenCount(null);
      setChatBusy(false);
    }
  }

  async function onToggleThinking(value: boolean) {
    if (!selectedSessionId) {
      return;
    }
    setChatBusy(true);
    setChatError(null);
    try {
      const response = await updateChatSession(selectedSessionId, {
        thinkingEnabled: value,
      });
      setSelectedSession(response.session);
      setContextUsage(response.contextUsage);
    } catch (error) {
      setChatError(error instanceof Error ? error.message : String(error));
    } finally {
      setChatBusy(false);
    }
  }

  async function onUpdateSessionPreset(presetId: string) {
    if (!selectedSessionId) {
      return;
    }
    setChatBusy(true);
    setChatError(null);
    try {
      const response = await updateChatSession(selectedSessionId, {
        presetId,
      });
      setSelectedSession(response.session);
      setContextUsage(response.contextUsage);
      setPlanRepoRootInput(response.session.planRepoRoot || '');
    } catch (error) {
      setChatError(error instanceof Error ? error.message : String(error));
    } finally {
      setChatBusy(false);
    }
  }

  async function onSavePlanRepoRoot() {
    if (!selectedSessionId || !planRepoRootInput.trim()) {
      return;
    }
    setChatBusy(true);
    setChatError(null);
    try {
      const response = await updateChatSession(selectedSessionId, {
        ...(selectedChatPreset?.id ? { presetId: selectedChatPreset.id } : {}),
        planRepoRoot: planRepoRootInput.trim(),
      });
      setSelectedSession(response.session);
      setContextUsage(response.contextUsage);
      setPlanRepoRootInput(response.session.planRepoRoot || '');
    } catch (error) {
      setChatError(error instanceof Error ? error.message : String(error));
    } finally {
      setChatBusy(false);
    }
  }

  async function onCondense() {
    if (!selectedSessionId) {
      return;
    }
    setChatBusy(true);
    setChatError(null);
    try {
      const response = await condenseChatSession(selectedSessionId);
      setSelectedSession(response.session);
      setContextUsage(response.contextUsage);
    } catch (error) {
      setChatError(error instanceof Error ? error.message : String(error));
    } finally {
      setChatBusy(false);
    }
  }

  async function onClearToolContext() {
    if (!selectedSessionId) {
      return;
    }
    const confirmed = window.confirm('Discard all hidden tool-call context for this session?');
    if (!confirmed) {
      return;
    }
    setChatBusy(true);
    setChatError(null);
    try {
      const response = await clearToolContext(selectedSessionId);
      setSelectedSession(response.session);
      setContextUsage(response.contextUsage);
    } catch (error) {
      setChatError(error instanceof Error ? error.message : String(error));
    } finally {
      setChatBusy(false);
    }
  }

  async function onDeleteSession() {
    if (!selectedSessionId) {
      return;
    }
    const confirmed = window.confirm('Delete this chat session permanently?');
    if (!confirmed) {
      return;
    }
    setChatBusy(true);
    setChatError(null);
    try {
      await deleteChatSession(selectedSessionId);
      const response = await getChatSessions();
      setSessions(response.sessions);
      const nextSession = response.sessions[0] ?? null;
      setSelectedSessionId(nextSession ? nextSession.id : '');
      setSelectedSession(nextSession);
      setContextUsage(null);
    } catch (error) {
      setChatError(error instanceof Error ? error.message : String(error));
    } finally {
      setChatBusy(false);
    }
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
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setSettingsError(message);
      enqueueToast('error', `Path picker failed: ${message}`);
    } finally {
      setSettingsPathPickerBusyTarget(null);
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
        <p>Runs, logs, metrics, and local chat context tracking.</p>
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
          onReloadDashboardSettings={onReloadDashboardSettings}
          restartDashboardBackendCore={restartDashboardBackendCore}
          onSaveDashboardSettings={onSaveDashboardSettings}
        />
      )}

      {tab === 'chat' && (
        <ChatTab
          sessions={sessions}
          selectedSessionId={selectedSessionId}
          selectedSession={selectedSession}
          sessionPromptCacheStats={sessionPromptCacheStats}
          webPresets={webPresets}
          selectedChatPreset={selectedChatPreset}
          chatMode={chatMode}
          isDirectChatMode={isDirectChatMode}
          isRepoToolMode={isRepoToolMode}
          isThinkingEnabledForCurrentSession={isThinkingEnabledForCurrentSession}
          showSettings={showSettings}
          planRepoRootInput={planRepoRootInput}
          planMaxTurnsInput={planMaxTurnsInput}
          contextUsage={contextUsage}
          liveToolPromptTokenCount={liveToolPromptTokenCount}
          thinkingDraft={thinkingDraft}
          answerDraft={answerDraft}
          planToolCalls={planToolCalls}
          chatInput={chatInput}
          chatBusy={chatBusy}
          chatError={chatError}
          onSelectSession={setSelectedSessionId}
          onToggleSettings={() => setShowSettings((prev) => !prev)}
          onChangePlanRepoRoot={setPlanRepoRootInput}
          onChangePlanMaxTurns={setPlanMaxTurnsInput}
          onChangeChatInput={setChatInput}
          onCreateSession={onCreateSession}
          onDeleteSession={onDeleteSession}
          onUpdateSessionPreset={onUpdateSessionPreset}
          onToggleThinking={onToggleThinking}
          onSavePlanRepoRoot={onSavePlanRepoRoot}
          onClearToolContext={onClearToolContext}
          onCondense={onCondense}
          onSendPlan={onSendPlan}
          onSendRepoSearch={onSendRepoSearch}
          onSendMessage={onSendMessage}
        />
      )}
    </main>
  );
}

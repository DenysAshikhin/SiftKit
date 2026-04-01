import { useEffect, useRef, useState } from 'react';
import {
  condenseChatSession,
  createPlanMessage,
  createChatSession,
  deleteChatSession,
  getChatSession,
  getChatSessions,
  getIdleSummary,
  getMetrics,
  getRunDetail,
  getRuns,
  streamChatMessage,
  updateChatSession,
} from './api';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type {
  ChatSession,
  ContextUsage,
  IdleSummarySnapshot,
  MetricDay,
  RunDetailResponse,
  RunRecord,
} from './types';

type TabKey = 'runs' | 'metrics' | 'chat';
type RunGroupKey = 'summary' | 'chat' | 'repo_search' | 'planner' | 'other';

function readSearchParams(): URLSearchParams {
  return new URLSearchParams(window.location.search);
}

function writeSearchParams(update: Record<string, string | null>): void {
  const params = readSearchParams();
  for (const [key, value] of Object.entries(update)) {
    if (value && value.trim()) {
      params.set(key, value);
    } else {
      params.delete(key);
    }
  }
  const query = params.toString();
  window.history.replaceState(null, '', `${window.location.pathname}${query ? `?${query}` : ''}`);
}

function formatNumber(value: number | null): string {
  if (!Number.isFinite(value)) {
    return '-';
  }
  return Number(value).toLocaleString();
}

function formatDate(value: string | null): string {
  if (!value) {
    return '-';
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return date.toLocaleString();
}

function classifyRunGroup(kind: string): RunGroupKey {
  const normalized = kind.trim().toLowerCase();
  if (normalized.includes('repo_search')) {
    return 'repo_search';
  }
  if (normalized.includes('chat')) {
    return 'chat';
  }
  if (normalized.includes('planner')) {
    return 'planner';
  }
  if (normalized.includes('summary') || normalized.includes('request')) {
    return 'summary';
  }
  return 'other';
}

function runGroupLabel(group: RunGroupKey): string {
  if (group === 'repo_search') {
    return 'Repo Search';
  }
  if (group === 'planner') {
    return 'Planner';
  }
  if (group === 'chat') {
    return 'Chat';
  }
  if (group === 'summary') {
    return 'Summary';
  }
  return 'Other';
}

function formatPercent(value: number | null): string {
  if (!Number.isFinite(value)) {
    return '-';
  }
  return `${(Number(value) * 100).toFixed(2)}%`;
}

function formatSecondsFromMs(value: number | null): string {
  if (!Number.isFinite(value)) {
    return '-';
  }
  return `${(Number(value) / 1000).toFixed(2)}s`;
}

function formatShortTime(value: string | null): string {
  if (!value) {
    return '-';
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return date.toLocaleTimeString();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function readStringField(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === 'string' && value.trim() ? value : null;
}

function extractRunFinalOutput(detail: RunDetailResponse): string | null {
  const events = detail.events;

  for (const event of events) {
    if (event.kind !== 'planner_debug' || !isRecord(event.payload)) {
      continue;
    }
    const finalNode = isRecord(event.payload.final) ? event.payload.final : null;
    if (!finalNode) {
      continue;
    }
    const finalOutput = readStringField(finalNode, 'finalOutput');
    if (finalOutput) {
      return finalOutput;
    }
  }

  for (const event of events) {
    if (event.kind !== 'summary_request' || !isRecord(event.payload)) {
      continue;
    }
    const summary = readStringField(event.payload, 'summary');
    if (summary) {
      return summary;
    }
  }

  const modelResponses = events
    .filter((event) => event.kind === 'turn_model_response' && isRecord(event.payload))
    .map((event) => readStringField(event.payload as Record<string, unknown>, 'text'))
    .filter((value): value is string => Boolean(value));
  if (modelResponses.length > 0) {
    return modelResponses[modelResponses.length - 1] ?? null;
  }

  return null;
}

function buildRunsSignature(items: RunRecord[]): string {
  return items
    .map((item) => `${item.id}|${item.status}|${item.kind}|${item.startedAtUtc || ''}|${item.finishedAtUtc || ''}`)
    .join('||');
}

function normalizeFinalOutputText(rawOutput: string): string {
  const trimmed = rawOutput.trim();
  let text = trimmed;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (isRecord(parsed)) {
      const outputText = readStringField(parsed, 'output')
        || readStringField(parsed, 'finalOutput')
        || readStringField(parsed, 'summary');
      if (outputText) {
        text = outputText;
      } else {
        text = JSON.stringify(parsed, null, 2);
      }
    }
  } catch {
    text = trimmed;
  }
  return text
    .replace(/\\r\\n/gu, '\n')
    .replace(/\\n/gu, '\n')
    .replace(/\\t/gu, '\t');
}

function formatRunEventPayload(event: { kind: string; payload: unknown }): string {
  if (!isRecord(event.payload)) {
    return '```json\n' + JSON.stringify(event.payload, null, 2) + '\n```';
  }
  const payload = event.payload as Record<string, unknown>;
  const scalarLines: string[] = [];
  const blockLines: string[] = [];
  const preferredTextFields = [
    'prompt',
    'text',
    'thinkingText',
    'output',
    'insertedResultText',
    'error',
    'warning',
  ];

  if (typeof payload.taskId === 'string' && payload.taskId.trim()) {
    scalarLines.push(`- Task: \`${payload.taskId}\``);
  }
  if (Number.isFinite(payload.turn as number)) {
    scalarLines.push(`- Turn: ${String(payload.turn)}`);
  }
  if (typeof payload.command === 'string' && payload.command.trim()) {
    scalarLines.push(`- Command: \`${payload.command.trim()}\``);
  }

  for (const field of preferredTextFields) {
    const value = payload[field];
    if (typeof value !== 'string' || !value.trim()) {
      continue;
    }
    blockLines.push(`**${field}**`);
    blockLines.push('```text');
    blockLines.push(normalizeFinalOutputText(value));
    blockLines.push('```');
  }

  const remaining: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload)) {
    if (key === 'taskId' || key === 'turn' || key === 'command' || preferredTextFields.includes(key)) {
      continue;
    }
    remaining[key] = value;
  }
  if (Object.keys(remaining).length > 0) {
    blockLines.push('**metadata**');
    blockLines.push('```json');
    blockLines.push(JSON.stringify(remaining, null, 2));
    blockLines.push('```');
  }

  if (scalarLines.length === 0 && blockLines.length === 0) {
    return '```json\n' + JSON.stringify(payload, null, 2) + '\n```';
  }
  return [...scalarLines, '', ...blockLines].join('\n').trim();
}

type SeriesPoint = {
  label: string;
  value: number;
};

type InteractiveSeries = {
  key: string;
  title: string;
  unit: string;
  color: string;
  points: SeriesPoint[];
};

type InteractiveGraphProps = {
  title: string;
  series: InteractiveSeries[];
  height?: number;
};

function buildLinePathFromValues(values: number[], width: number, height: number, maxValue: number): string {
  if (values.length === 0) {
    return '';
  }
  const safeMax = Math.max(1, maxValue);
  return values.map((value, index) => {
    const x = values.length === 1 ? width / 2 : (index / (values.length - 1)) * width;
    const y = height - ((Math.max(0, value) / safeMax) * height);
    return `${index === 0 ? 'M' : 'L'}${x.toFixed(2)} ${y.toFixed(2)}`;
  }).join(' ');
}

function InteractiveGraph({ title, series, height = 180 }: InteractiveGraphProps) {
  const width = 520;
  const [hiddenSeriesKeys, setHiddenSeriesKeys] = useState<Record<string, boolean>>({});
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  const pointCount = series.reduce((max, item) => Math.max(max, item.points.length), 0);
  const visibleSeries = series.filter((item) => !hiddenSeriesKeys[item.key]);
  const maxValue = Math.max(
    1,
    ...visibleSeries.flatMap((item) => item.points.map((point) => point.value))
  );
  const clampedHoverIndex = hoverIndex === null || pointCount <= 0
    ? null
    : Math.max(0, Math.min(pointCount - 1, hoverIndex));
  const hoverLabel = clampedHoverIndex === null
    ? null
    : (series.find((item) => item.points[clampedHoverIndex])?.points[clampedHoverIndex]?.label || null);

  return (
    <article className="interactive-graph">
      <header className="interactive-graph-header">
        <h3>{title}</h3>
        <span>{pointCount} points</span>
      </header>
      <div className="graph-legend">
        {series.map((item) => {
          const isHidden = Boolean(hiddenSeriesKeys[item.key]);
          const latest = item.points.length > 0 ? item.points[item.points.length - 1] : null;
          return (
            <button
              key={item.key}
              type="button"
              className={`graph-legend-chip ${isHidden ? 'off' : 'on'}`}
              onClick={() => {
                setHiddenSeriesKeys((previous) => ({
                  ...previous,
                  [item.key]: !previous[item.key],
                }));
              }}
            >
              <span className="dot" style={{ backgroundColor: item.color }} />
              {item.title}: {latest ? `${formatNumber(latest.value)} ${item.unit}` : '-'}
            </button>
          );
        })}
      </div>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label={title}
        onMouseMove={(event) => {
          if (pointCount <= 1) {
            return;
          }
          const box = event.currentTarget.getBoundingClientRect();
          const ratio = (event.clientX - box.left) / box.width;
          const index = Math.round(ratio * (pointCount - 1));
          setHoverIndex(index);
        }}
        onMouseLeave={() => setHoverIndex(null)}
      >
        <rect x="0" y="0" width={width} height={height} rx="8" ry="8" />
        {visibleSeries.map((item) => {
          const values = item.points.map((point) => point.value);
          const path = buildLinePathFromValues(values, width, height, maxValue);
          if (!path) {
            return null;
          }
          return (
            <path
              key={item.key}
              d={path}
              stroke={item.color}
              strokeWidth="2.4"
              fill="none"
            />
          );
        })}
        {clampedHoverIndex !== null && pointCount > 1 ? (
          <line
            x1={(clampedHoverIndex / (pointCount - 1)) * width}
            y1={0}
            x2={(clampedHoverIndex / (pointCount - 1)) * width}
            y2={height}
            stroke="#7f96ad88"
            strokeWidth="1"
          />
        ) : null}
      </svg>
      {hoverLabel ? (
        <div className="graph-tooltip">
          <strong>{hoverLabel}</strong>
          {visibleSeries.map((item) => {
            const point = item.points[clampedHoverIndex ?? 0];
            return (
              <span key={`${item.key}-hover`}>
                {item.title}: {point ? `${formatNumber(point.value)} ${item.unit}` : '-'}
              </span>
            );
          })}
        </div>
      ) : null}
    </article>
  );
}

export function App() {
  const params = readSearchParams();
  const [tab, setTab] = useState<TabKey>((params.get('tab') as TabKey) || 'runs');
  const [menuOpen, setMenuOpen] = useState(false);

  const [runs, setRuns] = useState<RunRecord[]>([]);
  const [runsLoading, setRunsLoading] = useState(false);
  const [runsError, setRunsError] = useState<string | null>(null);
  const [search, setSearch] = useState(params.get('search') || '');
  const [kindFilter, setKindFilter] = useState(params.get('kind') || '');
  const [statusFilter, setStatusFilter] = useState(params.get('status') || '');
  const [selectedRunId, setSelectedRunId] = useState(params.get('run') || '');
  const [selectedRunDetail, setSelectedRunDetail] = useState<RunDetailResponse | null>(null);
  const runsSignatureRef = useRef<string>('');
  const runsLoadedRef = useRef<boolean>(false);

  const [metrics, setMetrics] = useState<MetricDay[]>([]);
  const [metricsError, setMetricsError] = useState<string | null>(null);
  const [idleSummarySnapshots, setIdleSummarySnapshots] = useState<IdleSummarySnapshot[]>([]);

  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [selectedSessionId, setSelectedSessionId] = useState(params.get('session') || '');
  const [selectedSession, setSelectedSession] = useState<ChatSession | null>(null);
  const [contextUsage, setContextUsage] = useState<ContextUsage | null>(null);
  const [chatInput, setChatInput] = useState('');
  const [chatError, setChatError] = useState<string | null>(null);
  const [chatBusy, setChatBusy] = useState(false);
  const [thinkingDraft, setThinkingDraft] = useState('');
  const [answerDraft, setAnswerDraft] = useState('');
  const [planRepoRootInput, setPlanRepoRootInput] = useState('');
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
  const isThinkingEnabledForCurrentSession = selectedSession?.thinkingEnabled !== false;
  const chatMode = selectedSession?.mode === 'plan' ? 'plan' : 'chat';

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
        const response = await getRuns(search, kindFilter, statusFilter);
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
  }, [search, kindFilter, statusFilter]);

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
    setPlanRepoRootInput(selectedSession?.planRepoRoot || '');
  }, [selectedSession?.id, selectedSession?.planRepoRoot]);

  async function onCreateSession() {
    setChatBusy(true);
    setChatError(null);
    try {
      const response = await createChatSession({
        title: `Session ${new Date().toLocaleTimeString()}`,
        model: 'Qwen3.5-9B-Q8_0.gguf',
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
    try {
      const response = await createPlanMessage(selectedSessionId, {
        content: chatInput.trim(),
        repoRoot: planRepoRootInput.trim() || selectedSession?.planRepoRoot || '',
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

  async function onUpdateSessionMode(mode: 'chat' | 'plan') {
    if (!selectedSessionId) {
      return;
    }
    setChatBusy(true);
    setChatError(null);
    try {
      const response = await updateChatSession(selectedSessionId, {
        mode,
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
        mode: 'plan',
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
                onClick={() => {
                  setTab('runs');
                  setMenuOpen(false);
                }}
              >
                Logs
              </button>
              <button
                className={tab === 'metrics' ? 'active' : ''}
                onClick={() => {
                  setTab('metrics');
                  setMenuOpen(false);
                }}
              >
                Metrics
              </button>
              <button
                className={tab === 'chat' ? 'active' : ''}
                onClick={() => {
                  setTab('chat');
                  setMenuOpen(false);
                }}
              >
                Chat
              </button>
            </div>
          ) : null}
        </div>
        <h1>SiftKit Local Dashboard</h1>
        <p>Runs, logs, metrics, and local chat context tracking.</p>
      </header>

      {tab === 'runs' && (
        <section className="panel-grid">
          <section className="panel">
            <div className="filters">
              <input placeholder="Search runs" value={search} onChange={(event) => setSearch(event.target.value)} />
              <input placeholder="Kind filter" value={kindFilter} onChange={(event) => setKindFilter(event.target.value)} />
              <input placeholder="Status filter" value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)} />
            </div>
            {runsLoading && <p className="hint">Loading runs...</p>}
            {runsError && <p className="error">{runsError}</p>}
            {(Object.keys(groupedRuns) as RunGroupKey[]).map((group) => {
              const items = groupedRuns[group];
              if (items.length === 0) {
                return null;
              }
              return (
                <section key={group} className="run-group">
                  <header>{runGroupLabel(group)} ({items.length})</header>
                  <ul className="run-list">
                    {items.map((run) => (
                      <li key={run.id}>
                        <button className={selectedRunId === run.id ? 'selected' : ''} onClick={() => setSelectedRunId(run.id)}>
                          <span>{run.title}</span>
                          <span className="run-meta-line">
                            <span className={`run-chip kind ${classifyRunGroup(run.kind)}`}>{run.kind}</span>
                            <span className={`run-chip status ${String(run.status).toLowerCase()}`}>{run.status}</span>
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                </section>
              );
            })}
          </section>
          <section className="panel">
            {selectedRunDetail ? (
              <>
                <h2>{selectedRunDetail.run.title}</h2>
                <p className="hint">
                  {selectedRunDetail.run.id} |
                  {' '}
                  <span className={`run-chip kind ${classifyRunGroup(selectedRunDetail.run.kind)}`}>{selectedRunDetail.run.kind}</span>
                  {' '}
                  <span className={`run-chip status ${String(selectedRunDetail.run.status).toLowerCase()}`}>{selectedRunDetail.run.status}</span>
                </p>
                <p className="hint">Started: {formatDate(selectedRunDetail.run.startedAtUtc)} | Duration: {formatNumber(selectedRunDetail.run.durationMs)} ms</p>
                {(() => {
                  const finalOutput = extractRunFinalOutput(selectedRunDetail);
                  if (!finalOutput) {
                    return null;
                  }
                  const renderedFinalOutput = normalizeFinalOutputText(finalOutput);
                  return (
                  <details className="detail-card final-output-card" open>
                    <summary>Final Output</summary>
                    <div className="markdown-body">
                      <ReactMarkdown remarkPlugins={[remarkGfm]}>
                        {renderedFinalOutput}
                      </ReactMarkdown>
                    </div>
                  </details>
                  );
                })()}
                {selectedRunDetail.events.map((event, index) => (
                  <details key={`${event.kind}-${index}`} className="detail-card" open={index === 0}>
                    <summary>{event.kind} {event.at ? `| ${formatDate(event.at)}` : ''}</summary>
                    <div className="markdown-body">
                      <ReactMarkdown remarkPlugins={[remarkGfm]}>
                        {formatRunEventPayload(event)}
                      </ReactMarkdown>
                    </div>
                  </details>
                ))}
              </>
            ) : (
              <p className="hint">Select a run to inspect details.</p>
            )}
          </section>
        </section>
      )}

      {tab === 'metrics' && (
        <section className="panel">
          {metricsError && <p className="error">{metricsError}</p>}
          <div className="metrics-graph-grid">
            <InteractiveGraph
              title="Daily Usage"
              series={[
                { key: 'runs', title: 'Runs', unit: '', color: '#32c2a3', points: metrics.map((day) => ({ label: day.date, value: day.runs })) },
                { key: 'input', title: 'Input Tokens', unit: 'tok', color: '#53b6ff', points: metrics.map((day) => ({ label: day.date, value: day.inputTokens })) },
                { key: 'output', title: 'Output Tokens', unit: 'tok', color: '#ffb86c', points: metrics.map((day) => ({ label: day.date, value: day.outputTokens })) },
                { key: 'thinking', title: 'Thinking Tokens', unit: 'tok', color: '#d4a8ff', points: metrics.map((day) => ({ label: day.date, value: day.thinkingTokens })) },
                { key: 'duration', title: 'Avg Duration', unit: 'ms', color: '#8bc0ff', points: metrics.map((day) => ({ label: day.date, value: day.avgDurationMs })) },
              ]}
            />
            {idleSummarySnapshots.length > 1 ? (
              <InteractiveGraph
                title="Recent Snapshot Totals"
                series={[
                  {
                    key: 'requests',
                    title: 'Requests',
                    unit: '',
                    color: '#32c2a3',
                    points: recentIdlePoints.map((snapshot) => ({ label: formatShortTime(snapshot.emittedAtUtc), value: snapshot.completedRequestCount })),
                  },
                  {
                    key: 'input',
                    title: 'Input Tokens',
                    unit: 'tok',
                    color: '#53b6ff',
                    points: recentIdlePoints.map((snapshot) => ({ label: formatShortTime(snapshot.emittedAtUtc), value: snapshot.inputTokensTotal })),
                  },
                  {
                    key: 'output',
                    title: 'Output Tokens',
                    unit: 'tok',
                    color: '#ffb86c',
                    points: recentIdlePoints.map((snapshot) => ({ label: formatShortTime(snapshot.emittedAtUtc), value: snapshot.outputTokensTotal })),
                  },
                  {
                    key: 'thinking',
                    title: 'Thinking Tokens',
                    unit: 'tok',
                    color: '#d4a8ff',
                    points: recentIdlePoints.map((snapshot) => ({ label: formatShortTime(snapshot.emittedAtUtc), value: snapshot.thinkingTokensTotal })),
                  },
                ]}
              />
            ) : (
              <section className="idle-summary-history">
                <h3>Recent Snapshot Totals</h3>
                <p className="hint">Waiting for additional idle snapshots.</p>
              </section>
            )}
          </div>
          <section className="idle-summary-panel">
            <h3>Live Idle Summary</h3>
            {latestIdleSnapshot ? (
              <div className="idle-summary-cards">
                <p className="hint idle-latest">Latest: {formatDate(latestIdleSnapshot.emittedAtUtc)}</p>
                <article className="idle-card throughput">
                  <span>Requests</span>
                  <strong>{formatNumber(latestIdleSnapshot.completedRequestCount)}</strong>
                  <span>Avg Request: {formatSecondsFromMs(latestIdleSnapshot.avgRequestMs)}</span>
                  <span>Gen Tokens/s: {formatNumber(latestIdleSnapshot.avgTokensPerSecond)}</span>
                </article>
                <article className="idle-card token-totals">
                  <span>Input / Output / Thinking</span>
                  <strong>
                    {formatNumber(latestIdleSnapshot.inputTokensTotal)} / {formatNumber(latestIdleSnapshot.outputTokensTotal)} / {formatNumber(latestIdleSnapshot.thinkingTokensTotal)}
                  </strong>
                </article>
                <article className="idle-card compression">
                  <span>Compression</span>
                  <strong>{formatPercent(latestIdleSnapshot.savedPercent)}</strong>
                  <span>Ratio: {latestIdleSnapshot.compressionRatio ? `${latestIdleSnapshot.compressionRatio.toFixed(2)}x` : '-'}</span>
                </article>
              </div>
            ) : (
              <p className="hint">No snapshots yet. A summary appears when the backend reaches idle state.</p>
            )}
          </section>
        </section>
      )}

      {tab === 'chat' && (
        <section className="panel-grid chat-layout">
          <section className="panel">
            <div className="chat-header">
              <h2>Sessions</h2>
              <div className="chat-actions">
                <button onClick={() => { void onCreateSession(); }} disabled={chatBusy}>New</button>
                <button onClick={() => { void onDeleteSession(); }} disabled={chatBusy || !selectedSessionId}>Delete</button>
              </div>
            </div>
            <ul className="run-list">
              {sessions.map((session) => (
                <li key={session.id}>
                  <button className={selectedSessionId === session.id ? 'selected' : ''} onClick={() => setSelectedSessionId(session.id)}>
                    <span>{session.title}</span>
                    <span>{formatDate(session.updatedAtUtc)}</span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
          <section className="panel">
            {selectedSession ? (
              <>
                <h2>{selectedSession.title}</h2>
                <div className="thinking-toggle-row">
                  <label htmlFor="thinking-toggle">Thinking</label>
                  <input
                    id="thinking-toggle"
                    type="checkbox"
                    checked={selectedSession.thinkingEnabled !== false}
                    onChange={(event) => { void onToggleThinking(event.target.checked); }}
                    disabled={chatBusy}
                  />
                </div>
                <div className="chat-mode-row">
                  <button
                    type="button"
                    className={chatMode === 'chat' ? 'active' : ''}
                    onClick={() => { void onUpdateSessionMode('chat'); }}
                    disabled={chatBusy}
                  >
                    Chat
                  </button>
                  <button
                    type="button"
                    className={chatMode === 'plan' ? 'active' : ''}
                    onClick={() => { void onUpdateSessionMode('plan'); }}
                    disabled={chatBusy}
                  >
                    Plan
                  </button>
                </div>
                {chatMode === 'plan' ? (
                  <div className="plan-root-row">
                    <input
                      placeholder="Repo folder path for plan mode..."
                      value={planRepoRootInput}
                      onChange={(event) => setPlanRepoRootInput(event.target.value)}
                      disabled={chatBusy}
                    />
                    <button
                      type="button"
                      onClick={() => { void onSavePlanRepoRoot(); }}
                      disabled={chatBusy || !planRepoRootInput.trim()}
                    >
                      Save Folder
                    </button>
                  </div>
                ) : null}
                {contextUsage && (
                  <div className={contextUsage.shouldCondense ? 'usage warning' : 'usage'}>
                    <strong>
                      Context: {formatNumber(contextUsage.usedTokens)} / {formatNumber(contextUsage.contextWindowTokens)} tokens
                    </strong>
                    <span>Remaining: {formatNumber(contextUsage.remainingTokens)} | Warn at: {formatNumber(contextUsage.warnThresholdTokens)}</span>
                    {contextUsage.shouldCondense && (
                      <button onClick={() => { void onCondense(); }} disabled={chatBusy}>Condense Now</button>
                    )}
                  </div>
                )}
                {selectedSession.condensedSummary && (
                  <details className="detail-card">
                    <summary>Condensed Summary</summary>
                    <pre>{selectedSession.condensedSummary}</pre>
                  </details>
                )}
                <div className="chat-log">
                  {selectedSession.messages.map((message) => (
                    <article key={message.id} className={`msg ${message.role}`}>
                      <header>{message.role} | {formatDate(message.createdAtUtc)}</header>
                      {message.role === 'assistant' && message.thinkingContent ? (
                        <details className="thinking-box">
                          <summary>Thinking</summary>
                          <pre>{message.thinkingContent}</pre>
                        </details>
                      ) : null}
                      {message.role === 'assistant' ? (
                        <div className="markdown-body">
                          <ReactMarkdown remarkPlugins={[remarkGfm]}>
                            {message.content}
                          </ReactMarkdown>
                        </div>
                      ) : (
                        <p className="user-message">{message.content}</p>
                      )}
                    </article>
                  ))}
                </div>
                {chatBusy && (thinkingDraft || answerDraft) && (
                  <div className="live-stream-boxes">
                    {isThinkingEnabledForCurrentSession && (
                      <section className="live-box thinking">
                        <h3>Thinking</h3>
                        <pre>{thinkingDraft || '...'}</pre>
                      </section>
                    )}
                    <section className="live-box answer">
                      <h3>Answer</h3>
                      <div className="markdown-body">
                        <ReactMarkdown remarkPlugins={[remarkGfm]}>
                          {answerDraft || '...'}
                        </ReactMarkdown>
                      </div>
                    </section>
                  </div>
                )}
                <div className="composer">
                  <textarea
                    placeholder={chatMode === 'plan' ? 'Describe the feature to plan (plan mode runs repo-search)...' : 'Send a local chat message...'}
                    value={chatInput}
                    onChange={(event) => setChatInput(event.target.value)}
                    rows={4}
                  />
                  <button onClick={() => { if (chatMode === 'plan') { void onSendPlan(); return; } void onSendMessage(); }} disabled={chatBusy || !chatInput.trim()}>
                    {chatMode === 'plan' ? 'Generate Plan' : 'Send'}
                  </button>
                </div>
                {chatError && <p className="error">{chatError}</p>}
              </>
            ) : (
              <p className="hint">Create or pick a session.</p>
            )}
          </section>
        </section>
      )}
    </main>
  );
}

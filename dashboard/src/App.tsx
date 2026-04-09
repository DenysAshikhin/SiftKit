import { useEffect, useRef, useState } from 'react';
import {
  clearToolContext,
  condenseChatSession,
  createPlanMessage,
  streamPlanMessage,
  createChatSession,
  deleteChatSession,
  getChatSession,
  getChatSessions,
  getIdleSummary,
  getMetrics,
  getRunDetail,
  getRuns,
  streamChatMessage,
  streamRepoSearchMessage,
  updateChatSession,
} from './api';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  readHiddenSeriesState,
  sanitizeHiddenSeriesState,
  writeHiddenSeriesState,
  type KeyValueStore,
} from './metric-graph-persistence';
import type {
  ChatSession,
  ContextUsage,
  IdleSummarySnapshot,
  MetricDay,
  TaskMetricDay,
  ToolStatsByTask,
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

function getMessageTokenCount(message: ChatSession['messages'][number]): number {
  return Number(message.inputTokensEstimate || 0)
    + Number(message.outputTokensEstimate || 0)
    + Number(message.thinkingTokens || 0);
}

function isMessageTokenEstimateFallback(message: ChatSession['messages'][number]): boolean {
  return message.inputTokensEstimated === true
    || message.outputTokensEstimated === true
    || message.thinkingTokensEstimated === true;
}

function getSessionPromptCacheStats(session: ChatSession | null): {
  promptCacheTokens: number;
  promptEvalTokens: number;
  cacheHitRate: number | null;
} {
  if (!session || !Array.isArray(session.messages)) {
    return {
      promptCacheTokens: 0,
      promptEvalTokens: 0,
      cacheHitRate: null,
    };
  }
  const promptCacheTokens = session.messages.reduce((sum, message) => (
    Number.isFinite(message.promptCacheTokens) && Number(message.promptCacheTokens) >= 0
      ? sum + Number(message.promptCacheTokens)
      : sum
  ), 0);
  const promptEvalTokens = session.messages.reduce((sum, message) => (
    Number.isFinite(message.promptEvalTokens) && Number(message.promptEvalTokens) >= 0
      ? sum + Number(message.promptEvalTokens)
      : sum
  ), 0);
  const totalPromptTokens = promptCacheTokens + promptEvalTokens;
  return {
    promptCacheTokens,
    promptEvalTokens,
    cacheHitRate: totalPromptTokens > 0 ? (promptCacheTokens / totalPromptTokens) : null,
  };
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

function formatDurationHms(value: number | null): string {
  if (!Number.isFinite(value)) {
    return '-';
  }
  const totalSeconds = Math.max(0, Math.round(Number(value) / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const hh = String(hours).padStart(2, '0');
  const mm = String(minutes).padStart(2, '0');
  const ss = String(seconds).padStart(2, '0');
  return `${hh}:${mm}:${ss} (${hh}h ${mm}m ${ss}s)`;
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

function formatTaskKindLabel(taskKind: string): string {
  if (taskKind === 'repo-search') {
    return 'Repo Search';
  }
  if (taskKind === 'plan') {
    return 'Plan';
  }
  if (taskKind === 'summary') {
    return 'Summary';
  }
  if (taskKind === 'chat') {
    return 'Chat';
  }
  return taskKind;
}

function formatTaskKindClass(taskKind: string): string {
  const normalized = String(taskKind || '').trim().toLowerCase();
  if (!normalized) {
    return 'other';
  }
  return normalized.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'other';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function readStringField(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === 'string' && value.trim() ? value : null;
}

function readNumberField(record: Record<string, unknown>, key: string): number | null {
  const value = record[key];
  return Number.isFinite(value) ? Number(value) : null;
}

function formatCompactTokenCount(value: number): string {
  if (value >= 1000) {
    return `${Math.round(value / 1000)}k`;
  }
  return String(Math.round(value));
}

function formatStepContextUsed(payload: Record<string, unknown>): string | null {
  const promptTokenCount = readNumberField(payload, 'promptTokenCount');
  const remainingTokenAllowance = readNumberField(payload, 'remainingTokenAllowance');
  if (promptTokenCount === null || remainingTokenAllowance === null) {
    return null;
  }
  const totalBudget = promptTokenCount + remainingTokenAllowance;
  if (!Number.isFinite(totalBudget) || totalBudget <= 0) {
    return null;
  }
  const usedPercent = Math.max(0, Math.min(100, Math.round((promptTokenCount / totalBudget) * 100)));
  return `${formatCompactTokenCount(promptTokenCount)} (${usedPercent}%)`;
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

type RepoSearchChatStep = {
  id: string;
  prompt: string | null;
  command: string;
  output: string;
  contextUsed: string | null;
};

function buildRepoSearchChatSteps(events: RunDetailResponse['events']): RepoSearchChatStep[] {
  const contextUsedByCommandOrder: Array<string | null> = [];
  for (const event of events) {
    if (event.kind !== 'turn_command_result' || !isRecord(event.payload)) {
      continue;
    }
    contextUsedByCommandOrder.push(formatStepContextUsed(event.payload));
  }

  const stepsFromScorecard: RepoSearchChatStep[] = [];
  let contextUsedIndex = 0;
  for (const event of events) {
    if (event.kind !== 'run_done' || !isRecord(event.payload)) {
      continue;
    }
    const scorecard = isRecord(event.payload.scorecard) ? event.payload.scorecard : null;
    const tasks = scorecard && Array.isArray(scorecard.tasks) ? scorecard.tasks : [];
    for (let taskIndex = 0; taskIndex < tasks.length; taskIndex += 1) {
      const task = tasks[taskIndex];
      if (!isRecord(task)) {
        continue;
      }
      const question = readStringField(task, 'question');
      const commands = Array.isArray(task.commands) ? task.commands : [];
      for (let commandIndex = 0; commandIndex < commands.length; commandIndex += 1) {
        const commandRecord = commands[commandIndex];
        if (!isRecord(commandRecord)) {
          continue;
        }
        const command = readStringField(commandRecord, 'command');
        const output = readStringField(commandRecord, 'output');
        if (!command || !output) {
          continue;
        }
        stepsFromScorecard.push({
          id: `task-${taskIndex + 1}-step-${commandIndex + 1}`,
          prompt: commandIndex === 0 ? question : null,
          command,
          output,
          contextUsed: contextUsedByCommandOrder[contextUsedIndex++] ?? null,
        });
      }
    }
  }
  if (stepsFromScorecard.length > 0) {
    return stepsFromScorecard;
  }

  const stepsFromTurns: RepoSearchChatStep[] = [];
  for (const event of events) {
    if (event.kind !== 'turn_command_result' || !isRecord(event.payload)) {
      continue;
    }
    const taskId = readStringField(event.payload, 'taskId');
    const turn = event.payload.turn;
    const command = readStringField(event.payload, 'command');
    const output = readStringField(event.payload, 'insertedResultText') || readStringField(event.payload, 'output');
    if (!taskId || !Number.isFinite(turn as number) || !command || !output) {
      continue;
    }
    stepsFromTurns.push({
      id: `${taskId}-step-${String(turn)}`,
      prompt: null,
      command,
      output,
      contextUsed: formatStepContextUsed(event.payload),
    });
  }
  return stepsFromTurns;
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
  storageId: string;
  title: string;
  series: InteractiveSeries[];
  height?: number;
};

function getBrowserStorage(): KeyValueStore | null {
  if (typeof window === 'undefined') {
    return null;
  }
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function sameHiddenSeriesState(
  left: Record<string, boolean>,
  right: Record<string, boolean>,
): boolean {
  const leftKeys = Object.keys(left).filter((key) => left[key]).sort();
  const rightKeys = Object.keys(right).filter((key) => right[key]).sort();
  if (leftKeys.length !== rightKeys.length) {
    return false;
  }
  return leftKeys.every((key, index) => key === rightKeys[index]);
}

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

function InteractiveGraph({ storageId, title, series, height = 180 }: InteractiveGraphProps) {
  const width = 520;
  const seriesKeys = series.map((item) => item.key);
  const storage = getBrowserStorage();
  const [hiddenSeriesKeys, setHiddenSeriesKeys] = useState<Record<string, boolean>>(() => (
    readHiddenSeriesState(storage, storageId, seriesKeys)
  ));
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

  useEffect(() => {
    setHiddenSeriesKeys((previous) => {
      const sanitized = sanitizeHiddenSeriesState(previous, seriesKeys);
      return sameHiddenSeriesState(previous, sanitized) ? previous : sanitized;
    });
  }, [storageId, seriesKeys.join('|')]);

  useEffect(() => {
    writeHiddenSeriesState(storage, storageId, hiddenSeriesKeys, seriesKeys);
  }, [hiddenSeriesKeys, storage, storageId, seriesKeys.join('|')]);

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

/** Extract the `output` value from a streaming finish-action JSON string in real time. */
function extractFinishOutput(raw: string): string {
  const marker = /"output"\s*:\s*"/;
  const match = marker.exec(raw);
  if (!match) return raw;
  const start = match.index + match[0].length;
  let content = raw.slice(start);
  if (content.endsWith('"}') || content.endsWith('"\n}')) {
    content = content.slice(0, content.lastIndexOf('"'));
  } else if (content.includes('","confidence"')) {
    content = content.slice(0, content.indexOf('","confidence"'));
  }
  return content
    .replace(/\\n/g, '\n')
    .replace(/\\t/g, '\t')
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, '\\');
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
  const [repoSearchSimpleFlow, setRepoSearchSimpleFlow] = useState(true);
  const runsSignatureRef = useRef<string>('');
  const runsLoadedRef = useRef<boolean>(false);

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
  const [thinkingDraft, setThinkingDraft] = useState('');
  const [answerDraft, setAnswerDraft] = useState('');
  const [planRepoRootInput, setPlanRepoRootInput] = useState('');
  const [planMaxTurnsInput, setPlanMaxTurnsInput] = useState('45');
  const [planThinkingIntervalInput, setPlanThinkingIntervalInput] = useState('5');
  const [planToolCalls, setPlanToolCalls] = useState<Array<{
    turn: number;
    maxTurns: number;
    command: string;
    exitCode?: number;
    outputSnippet?: string;
    promptTokenCount?: number;
    status: 'running' | 'done';
  }>>([]);
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
  const taskMetricsSorted = taskMetrics
    .slice()
    .sort((left, right) => left.date.localeCompare(right.date) || left.taskKind.localeCompare(right.taskKind));
  const taskMetricsByKind = taskMetricsSorted.reduce<Record<string, TaskMetricDay[]>>((accumulator, entry) => {
    const rows = accumulator[entry.taskKind] || [];
    rows.push(entry);
    accumulator[entry.taskKind] = rows;
    return accumulator;
  }, {});
  const metricGroupOrder = ['summary', 'repo-search', 'plan', 'chat'];
  const taskMetricKindRows = Object.entries(taskMetricsByKind).sort((left, right) => {
    const leftIndex = metricGroupOrder.indexOf(left[0]);
    const rightIndex = metricGroupOrder.indexOf(right[0]);
    const normalizedLeft = leftIndex === -1 ? Number.MAX_SAFE_INTEGER : leftIndex;
    const normalizedRight = rightIndex === -1 ? Number.MAX_SAFE_INTEGER : rightIndex;
    if (normalizedLeft !== normalizedRight) {
      return normalizedLeft - normalizedRight;
    }
    return left[0].localeCompare(right[0]);
  });
  const toolMetricRows = toolMetrics
    ? Object.entries(toolMetrics).flatMap(([taskKind, byType]) => (
      Object.entries(byType || {}).map(([toolType, stats]) => ({
        taskKind,
        toolType,
        calls: Number(stats.calls || 0),
        outputCharsTotal: Number(stats.outputCharsTotal || 0),
        outputTokensTotal: Number(stats.outputTokensTotal || 0),
        outputTokensEstimatedCount: Number(stats.outputTokensEstimatedCount || 0),
      }))
    ))
    : [];
  const isRepoSearchRunSelected = selectedRunDetail
    ? classifyRunGroup(selectedRunDetail.run.kind) === 'repo_search'
    : false;
  const repoSearchChatSteps = selectedRunDetail ? buildRepoSearchChatSteps(selectedRunDetail.events) : [];
  const isThinkingEnabledForCurrentSession = selectedSession?.thinkingEnabled !== false;
  const chatMode = selectedSession?.mode === 'plan' ? 'plan' : selectedSession?.mode === 'repo-search' ? 'repo-search' : 'chat';
  const sessionPromptCacheStats = getSessionPromptCacheStats(selectedSession);

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
    setPlanToolCalls([]);
    setLiveToolPromptTokenCount(null);
    try {
      const parsedMaxTurns = Number(planMaxTurnsInput);
      const parsedThinkingInterval = Number(planThinkingIntervalInput);
      const response = await streamPlanMessage(
        selectedSessionId,
        {
          content: chatInput.trim(),
          repoRoot: planRepoRootInput.trim() || selectedSession?.planRepoRoot || '',
          ...(Number.isFinite(parsedMaxTurns) && parsedMaxTurns > 0 ? { maxTurns: parsedMaxTurns } : {}),
          ...(Number.isFinite(parsedThinkingInterval) && parsedThinkingInterval > 0 ? { thinkingInterval: parsedThinkingInterval } : {}),
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
      const parsedThinkingIntervalRS = Number(planThinkingIntervalInput);
      const response = await streamRepoSearchMessage(
        selectedSessionId,
        {
          content: chatInput.trim(),
          repoRoot: planRepoRootInput.trim() || selectedSession?.planRepoRoot || '',
          ...(Number.isFinite(parsedMaxTurnsRS) && parsedMaxTurnsRS > 0 ? { maxTurns: parsedMaxTurnsRS } : {}),
          ...(Number.isFinite(parsedThinkingIntervalRS) && parsedThinkingIntervalRS > 0 ? { thinkingInterval: parsedThinkingIntervalRS } : {}),
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

  async function onUpdateSessionMode(mode: 'chat' | 'plan' | 'repo-search') {
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
        mode: chatMode === 'repo-search' ? 'repo-search' : 'plan',
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
              <div className="filter-pill-row">
                <span className="filter-pill-label">Kind</span>
                <button
                  type="button"
                  className={`filter-pill kind summary ${kindFilter === 'summary' ? 'active' : ''}`}
                  onClick={() => setKindFilter((previous) => (previous === 'summary' ? '' : 'summary'))}
                >
                  Summary
                </button>
                <button
                  type="button"
                  className={`filter-pill kind repo_search ${kindFilter === 'repo_search' ? 'active' : ''}`}
                  onClick={() => setKindFilter((previous) => (previous === 'repo_search' ? '' : 'repo_search'))}
                >
                  Repo Search
                </button>
              </div>
              <div className="filter-pill-row">
                <span className="filter-pill-label">Status</span>
                <button
                  type="button"
                  className={`filter-pill status completed ${statusFilter === 'completed' ? 'active' : ''}`}
                  onClick={() => setStatusFilter((previous) => (previous === 'completed' ? '' : 'completed'))}
                >
                  Completed
                </button>
                <button
                  type="button"
                  className={`filter-pill status failed ${statusFilter === 'failed' ? 'active' : ''}`}
                  onClick={() => setStatusFilter((previous) => (previous === 'failed' ? '' : 'failed'))}
                >
                  Failed
                </button>
                <button
                  type="button"
                  className={`filter-pill status running ${statusFilter === 'running' ? 'active' : ''}`}
                  onClick={() => setStatusFilter((previous) => (previous === 'running' ? '' : 'running'))}
                >
                  Running
                </button>
              </div>
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
                <p className="hint">Started: {formatDate(selectedRunDetail.run.startedAtUtc)} | Duration: {formatDurationHms(selectedRunDetail.run.durationMs)}</p>
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
                {isRepoSearchRunSelected ? (
                  <div className="run-view-toggle-row">
                    <button
                      type="button"
                      className={repoSearchSimpleFlow ? 'active' : ''}
                      onClick={() => setRepoSearchSimpleFlow(true)}
                    >
                      Simplified Flow
                    </button>
                    <button
                      type="button"
                      className={!repoSearchSimpleFlow ? 'active' : ''}
                      onClick={() => setRepoSearchSimpleFlow(false)}
                    >
                      Raw Events
                    </button>
                  </div>
                ) : null}
                {isRepoSearchRunSelected && repoSearchSimpleFlow ? (
                  repoSearchChatSteps.length > 0 ? (
                    repoSearchChatSteps.map((step, index) => (
                      <details key={step.id} className="detail-card simple-flow-card" open={index === 0}>
                        <summary className="simple-flow-summary">
                          <span>Step {index + 1}</span>
                          <span className="simple-flow-summary-meta">{step.contextUsed || '-'}
                          </span>
                        </summary>
                        <div className="simple-flow-body">
                          {step.prompt ? (
                            <section className="simple-flow-section">
                              <h4>Prompt</h4>
                              <pre>{step.prompt}</pre>
                            </section>
                          ) : null}
                          <section className="simple-flow-section">
                            <h4>Command</h4>
                            <pre className="simple-flow-command">{step.command}</pre>
                          </section>
                          <section className="simple-flow-section">
                            <h4>Output</h4>
                            <pre>{step.output}</pre>
                          </section>
                        </div>
                      </details>
                    ))
                  ) : (
                    <p className="hint">No simplified steps found. Switch to Raw Events for full transcript details.</p>
                  )
                ) : (
                  selectedRunDetail.events.map((event, index) => (
                    <details key={`${event.kind}-${index}`} className="detail-card" open={index === 0}>
                      <summary>{event.kind} {event.at ? `| ${formatDate(event.at)}` : ''}</summary>
                      <div className="markdown-body">
                        <ReactMarkdown remarkPlugins={[remarkGfm]}>
                          {formatRunEventPayload(event)}
                        </ReactMarkdown>
                      </div>
                    </details>
                  ))
                )}
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
              storageId="daily-usage"
              title="Daily Usage"
              series={[
                { key: 'runs', title: 'Runs', unit: '', color: '#32c2a3', points: metrics.map((day) => ({ label: day.date, value: day.runs })) },
                { key: 'input', title: 'Input Tokens', unit: 'tok', color: '#53b6ff', points: metrics.map((day) => ({ label: day.date, value: day.inputTokens })) },
                { key: 'output', title: 'Output Tokens', unit: 'tok', color: '#ffb86c', points: metrics.map((day) => ({ label: day.date, value: day.outputTokens })) },
                { key: 'thinking', title: 'Thinking Tokens', unit: 'tok', color: '#d4a8ff', points: metrics.map((day) => ({ label: day.date, value: day.thinkingTokens })) },
                { key: 'tool', title: 'Tool Tokens', unit: 'tok', color: '#f38fd1', points: metrics.map((day) => ({ label: day.date, value: day.toolTokens })) },
                { key: 'duration', title: 'Avg Duration', unit: 'ms', color: '#8bc0ff', points: metrics.map((day) => ({ label: day.date, value: day.avgDurationMs })) },
              ]}
            />
            <InteractiveGraph
              storageId="prompt-cache-hit-rate"
              title="Prompt Cache Hit Rate"
              series={[
                {
                  key: 'cache-hit-rate',
                  title: 'Cache Hit Rate',
                  unit: '%',
                  color: '#71d36a',
                  points: metrics.map((day) => ({ label: day.date, value: Number.isFinite(day.cacheHitRate) ? Number(day.cacheHitRate) * 100 : 0 })),
                },
                {
                  key: 'cache-tokens',
                  title: 'Cache Tokens',
                  unit: 'tok',
                  color: '#4fbf90',
                  points: metrics.map((day) => ({ label: day.date, value: day.promptCacheTokens })),
                },
                {
                  key: 'prompt-eval-tokens',
                  title: 'Prompt Eval Tokens',
                  unit: 'tok',
                  color: '#6ec8ff',
                  points: metrics.map((day) => ({ label: day.date, value: day.promptEvalTokens })),
                },
              ]}
            />
            {idleSummarySnapshots.length > 1 ? (
              <InteractiveGraph
                storageId="recent-snapshot-totals"
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
          <section className="idle-summary-top-wrap">
            <div className="idle-top-row">
              <section className="idle-summary-panel idle-summary-compact">
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
              <section className="idle-summary-history idle-tools-panel">
                <h3>Tool Metrics</h3>
                {toolMetricRows.length > 0 ? (
                  <div className="idle-metric-card-row">
                    {toolMetricRows
                      .sort((left, right) => left.taskKind.localeCompare(right.taskKind) || left.toolType.localeCompare(right.toolType))
                      .map((entry) => {
                        const avgChars = entry.calls > 0 ? Math.round(entry.outputCharsTotal / entry.calls) : 0;
                        const avgTokens = entry.calls > 0 ? Math.round(entry.outputTokensTotal / entry.calls) : 0;
                        const estimatedRate = entry.calls > 0 ? (entry.outputTokensEstimatedCount / entry.calls) * 100 : 0;
                        return (
                          <article
                            key={`${entry.taskKind}-${entry.toolType}`}
                            className={`idle-card idle-metric-card metric-tool task-kind-${formatTaskKindClass(entry.taskKind)}`}
                          >
                            <span>{formatTaskKindLabel(entry.taskKind)}</span>
                            <strong>{entry.toolType}</strong>
                            <span>Calls: {formatNumber(entry.calls)}</span>
                            <span>Avg chars: {formatNumber(avgChars)}</span>
                            <span>Avg tokens: {formatNumber(avgTokens)}</span>
                            <span>Est rate: {estimatedRate.toFixed(1)}%</span>
                          </article>
                        );
                      })}
                  </div>
                ) : (
                  <p className="hint">No tool metrics available yet.</p>
                )}
              </section>
            </div>
          </section>
          <section className="idle-summary-history">
            <h3>Per-Task Daily Metrics</h3>
            {taskMetricKindRows.length > 0 ? (
              <div className="idle-kind-group-row">
                {taskMetricKindRows.map(([taskKind, entries]) => (
                  <section
                    key={taskKind}
                    className={`idle-kind-group task-kind-${formatTaskKindClass(taskKind)}`}
                  >
                    <h4>{formatTaskKindLabel(taskKind)}</h4>
                    <div className="idle-metric-card-row">
                      {entries.map((entry) => (
                        <article
                          key={`${entry.date}-${entry.taskKind}`}
                          className={`idle-card idle-metric-card metric-task task-kind-${formatTaskKindClass(entry.taskKind)}`}
                        >
                          <span>{entry.date}</span>
                          <strong>Runs: {formatNumber(entry.runs)}</strong>
                          <span>Input / Output / Thinking: {formatNumber(entry.inputTokens)} / {formatNumber(entry.outputTokens)} / {formatNumber(entry.thinkingTokens)}</span>
                          <span>Tool / Cache / Eval: {formatNumber(entry.toolTokens)} / {formatNumber(entry.promptCacheTokens)} / {formatNumber(entry.promptEvalTokens)}</span>
                          <span>Avg ms: {formatNumber(entry.avgDurationMs)}</span>
                        </article>
                      ))}
                    </div>
                  </section>
                ))}
              </div>
            ) : (
              <p className="hint">No per-task metrics available yet.</p>
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
                <div className="session-header-row">
                  <h2>{selectedSession.title}</h2>
                  <span className="hint">
                    Cache: {formatPercent(sessionPromptCacheStats.cacheHitRate)}
                    {' | '}
                    {formatNumber(sessionPromptCacheStats.promptCacheTokens)} cached
                    {' | '}
                    {formatNumber(sessionPromptCacheStats.promptEvalTokens)} eval
                  </span>
                </div>
                <div className="chat-mode-row">
                  <button
                    type="button"
                    className={showSettings ? 'active settings-toggle' : 'settings-toggle'}
                    onClick={() => setShowSettings((prev) => !prev)}
                    title="Toggle settings"
                  >
                    &#9881;
                  </button>
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
                  <button
                    type="button"
                    className={chatMode === 'repo-search' ? 'active' : ''}
                    onClick={() => { void onUpdateSessionMode('repo-search'); }}
                    disabled={chatBusy}
                  >
                    Repo Search
                  </button>
                  {(chatMode === 'plan' || chatMode === 'repo-search') && !showSettings && (
                    <span className="hint settings-summary" title="Click the gear icon to adjust">
                      {planMaxTurnsInput ? `${planMaxTurnsInput} turns` : ''}{planMaxTurnsInput && planThinkingIntervalInput ? ', ' : ''}{planThinkingIntervalInput ? `think every ${planThinkingIntervalInput}` : ''}
                    </span>
                  )}
                </div>
                {showSettings && (
                  <>
                    {chatMode === 'chat' ? (
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
                    ) : null}
                    {(chatMode === 'plan' || chatMode === 'repo-search') ? (
                      <div className="plan-root-row">
                        <input
                          placeholder="Repo folder path..."
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
                    {(chatMode === 'plan' || chatMode === 'repo-search') ? (
                      <div className="settings-inline-row">
                        <label htmlFor="max-turns-input" title="Maximum number of tool calls before stopping">Max Turns</label>
                        <input
                          id="max-turns-input"
                          type="number"
                          min="1"
                          max="200"
                          style={{ width: '70px' }}
                          value={planMaxTurnsInput}
                          onChange={(event) => setPlanMaxTurnsInput(event.target.value)}
                          disabled={chatBusy}
                        />
                        <label htmlFor="thinking-interval-input" title="Force a thinking step every N tool calls">Think Every</label>
                        <input
                          id="thinking-interval-input"
                          type="number"
                          min="1"
                          max="50"
                          style={{ width: '70px' }}
                          value={planThinkingIntervalInput}
                          onChange={(event) => setPlanThinkingIntervalInput(event.target.value)}
                          disabled={chatBusy}
                        />
                        <span className="hint" style={{ fontSize: '0.75rem' }}>steps</span>
                      </div>
                    ) : null}
                    {contextUsage && (
                      <div className={contextUsage.shouldCondense ? 'usage warning' : 'usage'}>
                        <strong>
                          <span title="Chat-visible token usage in this session, excluding hidden tool-call context.">
                            Context: {formatNumber(contextUsage.chatUsedTokens)} / {formatNumber(contextUsage.contextWindowTokens)} tokens
                          </span>
                        </strong>
                        <span title="Format: chat_tokens (total_tokens_including_hidden_tool_context).">
                          Remaining: {formatNumber(contextUsage.remainingTokens)}
                          {' | '}
                          {formatNumber(contextUsage.chatUsedTokens)} ({formatNumber(contextUsage.totalUsedTokens)} with tools)
                          {' | '}
                          Warn at: {formatNumber(contextUsage.warnThresholdTokens)}
                        </span>
                        {(chatMode === 'plan' || chatMode === 'repo-search') && Number.isFinite(liveToolPromptTokenCount) ? (
                          <span title="Latest backend prompt_tokens for an active plan/repo-search tool step.">
                            Live Step Prompt Tokens (backend): {formatNumber(liveToolPromptTokenCount)}
                          </span>
                        ) : null}
                        {Number(contextUsage.estimatedTokenFallbackTokens || 0) > 0 ? (
                          <span title="These session totals include local fallback estimates where backend usage was unavailable.">
                            Estimated Fallback: {formatNumber(Number(contextUsage.estimatedTokenFallbackTokens || 0))} tokens
                          </span>
                        ) : null}
                        <div className="usage-actions">
                          <button
                            onClick={() => { void onClearToolContext(); }}
                            disabled={chatBusy || Number(contextUsage.toolUsedTokens || 0) <= 0}
                          >
                            Discard Tool Context
                          </button>
                        </div>
                        {contextUsage.shouldCondense && (
                          <button onClick={() => { void onCondense(); }} disabled={chatBusy}>Condense Now</button>
                        )}
                      </div>
                    )}
                  </>
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
                      <header className="msg-header">
                        <span>{message.role} | {formatDate(message.createdAtUtc)}</span>
                        <span
                          className="msg-tokens"
                          title="Format: tokens_for_message (associated hidden tool-call tokens)."
                        >
                          {formatNumber(getMessageTokenCount(message))}
                          {isMessageTokenEstimateFallback(message) ? ' est.' : ''}
                          {' '}
                          ({formatNumber(Number(message.associatedToolTokens || 0))})
                        </span>
                      </header>
                      {chatMode === 'chat' && message.role === 'assistant' && message.thinkingContent ? (
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
                {chatBusy && (thinkingDraft || answerDraft || planToolCalls.length > 0) && (
                  <div className="live-stream-boxes">
                    {((chatMode === 'chat' && isThinkingEnabledForCurrentSession) || ((chatMode === 'plan' || chatMode === 'repo-search') && thinkingDraft)) && (
                      <section className="live-box thinking">
                        <h3>{chatMode === 'plan' ? 'Plan Thinking' : chatMode === 'repo-search' ? 'Search Thinking' : 'Thinking'}</h3>
                        <pre>{thinkingDraft || '...'}</pre>
                      </section>
                    )}
                    {(chatMode === 'plan' || chatMode === 'repo-search') && planToolCalls.length > 0 && (
                      <section className="live-box tool-calls">
                        <h3>Queries ({planToolCalls.length})</h3>
                        <ul className="tool-call-list">
                          {[...planToolCalls].reverse().map((tc, i) => (
                            <li key={i} className={tc.status === 'running' ? 'tool-running' : 'tool-done'}>
                              <code>{tc.command}</code>
                              {tc.status === 'running' && <span className="tool-spinner"> ...</span>}
                              {tc.status === 'done' && tc.outputSnippet && (
                                <pre className="tool-snippet">{tc.outputSnippet}</pre>
                              )}
                              {tc.status === 'done' && typeof tc.exitCode === 'number' && (
                                <span className={tc.exitCode === 0 ? 'exit-ok' : 'exit-fail'}>
                                  {' '}exit {tc.exitCode}
                                </span>
                              )}
                            </li>
                          ))}
                        </ul>
                      </section>
                    )}
                    {(chatMode === 'chat' || chatMode === 'repo-search') && (
                      <section className="live-box answer">
                        <h3>{chatMode === 'repo-search' ? 'Search Thinking' : 'Answer'}</h3>
                        <div className="markdown-body">
                          <ReactMarkdown remarkPlugins={[remarkGfm]}>
                            {chatMode === 'repo-search' ? extractFinishOutput(answerDraft) || '...' : answerDraft || '...'}
                          </ReactMarkdown>
                        </div>
                      </section>
                    )}
                  </div>
                )}
                <div className="composer">
                  <textarea
                    placeholder={chatMode === 'plan' ? 'Describe the feature to plan (plan mode runs repo-search)...' : chatMode === 'repo-search' ? 'Enter a repo search query...' : 'Send a local chat message...'}
                    value={chatInput}
                    onChange={(event) => setChatInput(event.target.value)}
                    rows={4}
                  />
                  <button onClick={() => { if (chatMode === 'plan') { void onSendPlan(); return; } if (chatMode === 'repo-search') { void onSendRepoSearch(); return; } void onSendMessage(); }} disabled={chatBusy || !chatInput.trim()}>
                    {chatMode === 'plan' ? 'Generate Plan' : chatMode === 'repo-search' ? 'Search' : 'Send'}
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

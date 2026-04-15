import { useEffect, useRef, useState, type ReactNode } from 'react';
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
  applyOperationModeDefaults,
  applyPresetKindDefaults,
  getDefaultToolsForOperationMode,
  getEffectivePresetTools,
  PRESET_TOOL_OPTIONS,
  PRESET_TOOL_DESCRIPTIONS,
  getFallbackPresetId,
  getNextPresetIdAfterDelete,
  getPresetToolsSummary,
  togglePresetTool,
} from './preset-editor';
import { getDashboardView } from './dashboard-route';
import { getDirtyActionRequirement, type DirtyContinuation } from './settings-flow';
import {
  POLICY_MODE_OPTIONS,
  SETTINGS_SECTION_ORDER,
  SETTINGS_SECTIONS,
  getSettingsFieldDescriptor,
  type SettingsFieldLayout,
  type SettingsSectionId,
} from './settings-sections';
import { deriveRuntimeModelId, syncDerivedSettingsFields } from './settings-runtime';
import { SettingsMockupPage } from './settings-mockup';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  readHiddenSeriesState,
  sanitizeHiddenSeriesState,
  writeHiddenSeriesState,
  type KeyValueStore,
} from './metric-graph-persistence';
import {
  buildTaskRunsSeries,
  describeToolType,
  getGraphHoverIndex,
  sortToolMetricsByCalls,
} from './metrics-view';
import type {
  ChatSession,
  ContextUsage,
  DashboardConfig,
  DashboardPreset,
  IdleSummarySnapshot,
  MetricDay,
  RunGroupFilter,
  TaskMetricDay,
  ToolStatsByTask,
  RunDetailResponse,
  RunLogDeleteType,
  RunRecord,
} from './types';

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
        preserveAspectRatio="none"
        role="img"
        aria-label={title}
        onMouseLeave={() => setHoverIndex(null)}
      >
        <rect className="graph-frame" x="0" y="0" width={width} height={height} rx="8" ry="8" />
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
        <rect
          className="graph-hover-layer"
          x="0"
          y="0"
          width={width}
          height={height}
          rx="8"
          ry="8"
          fill="transparent"
          pointerEvents="all"
          onMouseMove={(event) => {
            const box = event.currentTarget.getBoundingClientRect();
            setHoverIndex(getGraphHoverIndex(pointCount, event.clientX - box.left, box.width));
          }}
          onMouseLeave={() => setHoverIndex(null)}
        />
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

function cloneDashboardConfig(config: DashboardConfig): DashboardConfig {
  return syncDerivedSettingsFields(JSON.parse(JSON.stringify(config)) as DashboardConfig);
}

function getDashboardConfigSignature(config: DashboardConfig | null): string {
  return config ? JSON.stringify(config) : '';
}

function parseIntegerInput(value: string, fallback: number): number {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseFloatInput(value: string, fallback: number): number {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

type SettingsFieldProps = {
  label: string;
  layout: SettingsFieldLayout;
  helpText?: string | undefined;
  children: ReactNode;
};

function SettingsField({ label, layout, helpText, children }: SettingsFieldProps) {
  return (
    <div className={`settings-live-field settings-live-field-${layout}`}>
      <div className="settings-live-label-row">
        <SettingsInlineHelpLabel label={label} helpText={helpText} />
      </div>
      {children}
    </div>
  );
}

function SettingsInlineHelpLabel({ label, helpText }: { label: string; helpText?: string | undefined }) {
  return (
    <>
      <label>{label}</label>
      {helpText ? (
        <span className="settings-live-help">
          <button type="button" className="settings-live-help-trigger" aria-label={`Explain ${label}`}>
            ?
          </button>
          <span className="settings-live-help-popover" role="note">
            {helpText}
          </span>
        </span>
      ) : null}
    </>
  );
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
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [settingsSavedAtUtc, setSettingsSavedAtUtc] = useState<string | null>(null);
  const [activeSettingsSection, setActiveSettingsSection] = useState<SettingsSectionId>('general');
  const [selectedSettingsPresetId, setSelectedSettingsPresetId] = useState<string | null>(null);
  const [pendingSettingsContinuation, setPendingSettingsContinuation] = useState<DirtyContinuation | null>(null);
  const [showSettingsConfirm, setShowSettingsConfirm] = useState(false);
  const [toasts, setToasts] = useState<ToastMessage[]>([]);
  const managedLlamaWarningRef = useRef<string | null>(null);
  const healthCheckErrorRef = useRef<string | null>(null);
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
  const toolMetricRows = toolMetrics
    ? Object.entries(toolMetrics).flatMap(([taskKind, byType]) => (
      Object.entries(byType || {}).map(([toolType, stats]) => ({
        taskKind,
        toolType,
        calls: Number(stats.calls || 0),
        outputCharsTotal: Number(stats.outputCharsTotal || 0),
        outputTokensTotal: Number(stats.outputTokensTotal || 0),
        outputTokensEstimatedCount: Number(stats.outputTokensEstimatedCount || 0),
        lineReadCalls: Number(stats.lineReadCalls || 0),
        lineReadLinesTotal: Number(stats.lineReadLinesTotal || 0),
        lineReadTokensTotal: Number(stats.lineReadTokensTotal || 0),
        finishRejections: Number(stats.finishRejections || 0),
        semanticRepeatRejects: Number(stats.semanticRepeatRejects || 0),
        stagnationWarnings: Number(stats.stagnationWarnings || 0),
        forcedFinishFromStagnation: Number(stats.forcedFinishFromStagnation || 0),
        promptInsertedTokens: Number(stats.promptInsertedTokens || 0),
        rawToolResultTokens: Number(stats.rawToolResultTokens || 0),
        newEvidenceCalls: Number(stats.newEvidenceCalls || 0),
        noNewEvidenceCalls: Number(stats.noNewEvidenceCalls || 0),
        lineReadRecommendedLines: Number.isFinite(Number(stats.lineReadRecommendedLines))
          ? Number(stats.lineReadRecommendedLines)
          : null,
        lineReadAllowanceTokens: Number.isFinite(Number(stats.lineReadAllowanceTokens))
          ? Number(stats.lineReadAllowanceTokens)
          : null,
      }))
    ))
    : [];
  const sortedToolMetricRows = sortToolMetricsByCalls(toolMetricRows);
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
  const settingsActionBusy = settingsLoading || settingsSaving || settingsRestarting;
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
    let cancelled = false;
    let pollTimer: ReturnType<typeof window.setTimeout> | null = null;
    async function pollHealth(): Promise<void> {
      try {
        const health = await getDashboardHealth();
        if (cancelled) {
          return;
        }
        healthCheckErrorRef.current = null;
        const warning = typeof health.managedLlamaStartupWarning === 'string' && health.managedLlamaStartupWarning.trim()
          ? health.managedLlamaStartupWarning.trim()
          : null;
        if (warning && warning !== managedLlamaWarningRef.current) {
          enqueueToast('warning', `Managed llama.cpp unavailable: ${warning}`);
        } else if (!warning && managedLlamaWarningRef.current) {
          enqueueToast('info', 'Managed llama.cpp recovered.');
        }
        managedLlamaWarningRef.current = warning;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!cancelled && message !== healthCheckErrorRef.current) {
          healthCheckErrorRef.current = message;
          enqueueToast('error', `Dashboard health check failed: ${message}`);
        }
      } finally {
        if (!cancelled) {
          pollTimer = window.setTimeout(() => {
            void pollHealth();
          }, 10_000);
        }
      }
    }
    void pollHealth();
    return () => {
      cancelled = true;
      if (pollTimer !== null) {
        window.clearTimeout(pollTimer);
      }
    };
  }, []);

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
        thinkingInterval: null,
        thinkingEnabled: null,
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
    if (selectedChatPreset.thinkingInterval !== null) {
      setPlanThinkingIntervalInput(String(selectedChatPreset.thinkingInterval));
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
    try {
      await restartBackend();
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

  function renderSettingsSection(): ReactNode {
    if (!dashboardConfig) {
      return null;
    }

    const renderField = (sectionId: SettingsSectionId, label: string, children: ReactNode): ReactNode => {
      const field = getSettingsFieldDescriptor(sectionId, label);
      return (
        <SettingsField key={label} label={label} layout={field.layout} helpText={field.helpText}>
          {children}
        </SettingsField>
      );
    };

    if (activeSettingsSection === 'general') {
      return (
        <div className="settings-live-grid">
          {renderField('general', 'Version', (
            <input
              value={dashboardConfig.Version}
              onChange={(event) => updateSettingsDraft((next) => { next.Version = event.target.value; })}
            />
          ))}
          {renderField('general', 'Backend', (
            <div className="settings-live-nav-control">
              <input value={dashboardConfig.Backend} readOnly />
              <button
                type="button"
                onClick={() => requestSettingsAction({ kind: 'switch-section', nextSection: 'model-runtime' })}
              >
                Open Model Path
              </button>
            </div>
          ))}
          {renderField('general', 'Policy Mode', (
            <select
              value={dashboardConfig.PolicyMode}
              onChange={(event) => updateSettingsDraft((next) => { next.PolicyMode = event.target.value; })}
            >
              {POLICY_MODE_OPTIONS.map((option) => (
                <option key={option} value={option}>{option}</option>
              ))}
            </select>
          ))}
          {renderField('general', 'Raw log retention', (
            <label className="settings-live-toggle-control">
              <input
                type="checkbox"
                checked={dashboardConfig.RawLogRetention}
                onChange={(event) => updateSettingsDraft((next) => { next.RawLogRetention = event.target.checked; })}
              />
              <span>{dashboardConfig.RawLogRetention ? 'Enabled' : 'Disabled'}</span>
            </label>
          ))}
          {renderField('general', 'Prompt prefix', (
            <textarea
              rows={5}
              value={dashboardConfig.PromptPrefix || ''}
              onChange={(event) => updateSettingsDraft((next) => { next.PromptPrefix = event.target.value; })}
            />
          ))}
        </div>
      );
    }

    if (activeSettingsSection === 'tool-policy') {
      return (
        <div className="settings-live-grid">
          {renderField('tool-policy', 'Operation mode tool policy', (
            <div className="settings-preset-mode-grid">
              {(['summary', 'read-only', 'full'] as const).map((operationMode) => (
                <div key={operationMode} className="settings-preset-mode-card">
                  <span className="settings-preset-mode-title">
                    <SettingsInlineHelpLabel
                      label={operationMode}
                      helpText={`Globally allowed tools for ${operationMode} mode.`}
                    />
                  </span>
                  <div className="settings-preset-tools-list compact">
                    {PRESET_TOOL_OPTIONS.map((tool) => (
                      <label key={`${operationMode}-${tool}`} className="settings-preset-tools-option" tabIndex={0}>
                        <input
                          type="checkbox"
                          checked={dashboardConfig.OperationModeAllowedTools[operationMode].includes(tool)}
                          onChange={() => updateSettingsDraft((next) => {
                            next.OperationModeAllowedTools[operationMode] = togglePresetTool(
                              next.OperationModeAllowedTools[operationMode],
                              tool,
                            );
                          })}
                        />
                        <span className="settings-preset-tools-option-label">{tool}</span>
                        <span className="settings-preset-tools-option-popover" role="tooltip">
                          <strong>{tool}</strong>
                          {PRESET_TOOL_DESCRIPTIONS[tool]}
                        </span>
                      </label>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          ))}
        </div>
      );
    }

    if (activeSettingsSection === 'presets') {
      return (
        <div className="settings-live-grid">
          {renderField('presets', 'Preset library', (
            <div className="settings-preset-library">
              <div className="settings-preset-toolbar">
                <label className="settings-preset-selector">
                  <span className="settings-preset-inline-label"><SettingsInlineHelpLabel label="Preset" helpText="Pick which preset to edit." /></span>
                  <select
                    value={selectedSettingsPreset?.id ?? ''}
                    onChange={(event) => {
                      setSelectedSettingsPresetId(event.target.value);
                    }}
                    disabled={dashboardConfig.Presets.length === 0}
                  >
                    {dashboardConfig.Presets.length === 0 ? <option value="">No presets</option> : null}
                    {dashboardConfig.Presets.map((preset) => (
                      <option key={preset.id} value={preset.id}>{preset.label}</option>
                    ))}
                  </select>
                </label>
                <div className="settings-preset-library-actions">
                  <button type="button" onClick={onAddPreset}>Add Preset</button>
                  <button
                    type="button"
                    onClick={() => {
                      if (selectedSettingsPreset) {
                        onDeletePreset(selectedSettingsPreset.id);
                      }
                    }}
                    disabled={!selectedSettingsPreset?.deletable}
                  >
                    Delete
                  </button>
                </div>
              </div>
              {selectedSettingsPreset ? (
                <article className="settings-preset-card">
                  <header className="settings-preset-card-header">
                    <div>
                      <strong>{selectedSettingsPreset.label}</strong>
                      <span className="hint">{selectedSettingsPreset.id} | {selectedSettingsPreset.presetKind} | {selectedSettingsPreset.operationMode} | {selectedSettingsPreset.deletable ? 'custom' : 'builtin'}</span>
                    </div>
                  </header>
                  <div className="settings-preset-card-grid">
                    <label>
                      <span className="settings-preset-inline-label"><SettingsInlineHelpLabel label="Name" helpText="User-facing preset label shown in pickers." /></span>
                      <input
                        value={selectedSettingsPreset.label}
                        onChange={(event) => updatePresetDraft(selectedSettingsPreset.id, (next) => { next.label = event.target.value; })}
                      />
                    </label>
                    <label>
                      <span className="settings-preset-inline-label"><SettingsInlineHelpLabel label="Preset kind" helpText="Routing and output behavior for this preset: summary, chat, plan, or repo-search." /></span>
                      <select
                        value={selectedSettingsPreset.presetKind}
                        onChange={(event) => updatePresetDraft(selectedSettingsPreset.id, (next) => {
                          applyPresetKindDefaults(
                            next,
                            event.target.value as DashboardPreset['presetKind'],
                          );
                        })}
                        disabled={selectedSettingsPreset.builtin}
                      >
                        <option value="summary">summary</option>
                        <option value="chat">chat</option>
                        <option value="plan">plan</option>
                        <option value="repo-search">repo-search</option>
                      </select>
                    </label>
                    <label>
                      <span className="settings-preset-inline-label"><SettingsInlineHelpLabel label="Operation mode" helpText="Capability policy for this preset: direct summary fallback tools, read-only repo tools, or future full tools." /></span>
                      <select
                        value={selectedSettingsPreset.operationMode}
                        onChange={(event) => updatePresetDraft(selectedSettingsPreset.id, (next) => {
                          applyOperationModeDefaults(
                            next,
                            event.target.value as DashboardPreset['operationMode'],
                          );
                        })}
                      >
                        <option value="summary">summary</option>
                        <option value="read-only">read-only</option>
                        <option value="full">full</option>
                      </select>
                    </label>
                    <label>
                      <span className="settings-preset-inline-label"><SettingsInlineHelpLabel label="CLI surface" helpText="Whether this preset appears in CLI discovery and can run from `siftkit run --preset`." /></span>
                      <input
                        type="checkbox"
                        checked={selectedSettingsPreset.surfaces.includes('cli')}
                        onChange={(event) => updatePresetDraft(selectedSettingsPreset.id, (next) => {
                          next.surfaces = event.target.checked
                            ? Array.from(new Set([...next.surfaces, 'cli']))
                            : next.surfaces.filter((surface) => surface !== 'cli');
                        })}
                      />
                    </label>
                    <label>
                      <span className="settings-preset-inline-label"><SettingsInlineHelpLabel label="Web surface" helpText="Whether this preset appears in the dashboard chat preset picker." /></span>
                      <input
                        type="checkbox"
                        checked={selectedSettingsPreset.surfaces.includes('web')}
                        onChange={(event) => updatePresetDraft(selectedSettingsPreset.id, (next) => {
                          next.surfaces = event.target.checked
                            ? Array.from(new Set([...next.surfaces, 'web']))
                            : next.surfaces.filter((surface) => surface !== 'web');
                        })}
                      />
                    </label>
                    <label className="settings-preset-card-wide">
                      <span className="settings-preset-inline-label"><SettingsInlineHelpLabel label="Description" helpText="Short operator-facing explanation of when to use this preset." /></span>
                      <input
                        value={selectedSettingsPreset.description}
                        onChange={(event) => updatePresetDraft(selectedSettingsPreset.id, (next) => { next.description = event.target.value; })}
                      />
                    </label>
                    <label className="settings-preset-card-wide">
                      <span className="settings-preset-inline-label"><SettingsInlineHelpLabel label="Prompt override" helpText="Preset-specific instruction prefix layered onto the family behavior. Leave empty to fall back to the global prompt prefix or family default." /></span>
                      <textarea
                        rows={3}
                        value={selectedSettingsPreset.promptPrefix}
                        onChange={(event) => updatePresetDraft(selectedSettingsPreset.id, (next) => { next.promptPrefix = event.target.value; })}
                      />
                    </label>
                    <label className="settings-preset-card-wide">
                      <span className="settings-preset-inline-label"><SettingsInlineHelpLabel label="Allowed tools" helpText="Tools permitted for this preset. Toggle each option directly." /></span>
                      <div className="settings-preset-tools-list">
                        {PRESET_TOOL_OPTIONS.map((tool) => (
                          <label key={tool} className="settings-preset-tools-option" tabIndex={0}>
                            <input
                              type="checkbox"
                              checked={selectedSettingsPreset.allowedTools.includes(tool)}
                              onChange={() => updatePresetDraft(selectedSettingsPreset.id, (next) => {
                                next.allowedTools = togglePresetTool(next.allowedTools, tool);
                              })}
                            />
                            <span className="settings-preset-tools-option-label">{tool}</span>
                            <span className="settings-preset-tools-option-popover" role="tooltip">
                              <strong>{tool}</strong>
                              {PRESET_TOOL_DESCRIPTIONS[tool]}
                            </span>
                          </label>
                        ))}
                      </div>
                    </label>
                    <label className="settings-preset-card-wide">
                      <span className="settings-preset-inline-label"><SettingsInlineHelpLabel label="Effective tools" helpText="Intersection of the preset whitelist and the global operation-mode policy." /></span>
                      <input
                        readOnly
                        value={getPresetToolsSummary(getEffectivePresetTools(
                          selectedSettingsPreset,
                          dashboardConfig.OperationModeAllowedTools,
                        )) || 'No tools enabled'}
                      />
                    </label>
                    {selectedSettingsPreset.operationMode === 'read-only' ? (
                      <>
                        <label>
                          <span className="settings-preset-inline-label"><SettingsInlineHelpLabel label="Include AGENTS.md" helpText="Adds the repository root `agents.md` or `AGENTS.md` instructions block to the read-only tool-call system prompt." /></span>
                          <input
                            type="checkbox"
                            checked={selectedSettingsPreset.includeAgentsMd}
                            onChange={(event) => updatePresetDraft(selectedSettingsPreset.id, (next) => { next.includeAgentsMd = event.target.checked; })}
                          />
                        </label>
                        <label>
                          <span className="settings-preset-inline-label"><SettingsInlineHelpLabel label="Include repo file list" helpText="Adds the startup repository file listing to the read-only tool-call user prompt before tool calls begin." /></span>
                          <input
                            type="checkbox"
                            checked={selectedSettingsPreset.includeRepoFileListing}
                            onChange={(event) => updatePresetDraft(selectedSettingsPreset.id, (next) => { next.includeRepoFileListing = event.target.checked; })}
                          />
                        </label>
                      </>
                    ) : null}
                    <label>
                      <span className="settings-preset-inline-label"><SettingsInlineHelpLabel label="Use for default summary" helpText="Marks the summary preset used by default CLI summarization flows." /></span>
                      <input
                        type="checkbox"
                        checked={selectedSettingsPreset.useForSummary}
                        onChange={(event) => updateSettingsDraft((next) => {
                          next.Presets.forEach((entry) => {
                            entry.useForSummary = entry.id === selectedSettingsPreset.id ? event.target.checked : false;
                          });
                        })}
                        disabled={selectedSettingsPreset.presetKind !== 'summary'}
                      />
                    </label>
                  </div>
                </article>
              ) : null}
            </div>
          ))}
        </div>
      );
    }

    if (activeSettingsSection === 'model-runtime') {
      return (
        <div className="settings-live-grid">
          {renderField('model-runtime', 'Runtime model id', (
            <input
              value={deriveRuntimeModelId(dashboardConfig.Runtime.LlamaCpp.ModelPath)}
              readOnly
            />
          ))}
          {renderField('model-runtime', 'llama.cpp Base URL', (
            <input
              value={dashboardConfig.Runtime.LlamaCpp.BaseUrl}
              onChange={(event) => updateSettingsDraft((next) => {
                next.Runtime.LlamaCpp.BaseUrl = event.target.value;
                next.LlamaCpp.BaseUrl = event.target.value;
              })}
            />
          ))}
          {renderField('model-runtime', 'Model path (.gguf)', (
            <input
              value={dashboardConfig.Runtime.LlamaCpp.ModelPath || ''}
              onChange={(event) => updateSettingsDraft((next) => {
                const value = event.target.value.trim();
                next.Runtime.LlamaCpp.ModelPath = value || null;
                next.LlamaCpp.ModelPath = value || null;
                next.Runtime.Model = deriveRuntimeModelId(value || null);
                next.Model = next.Runtime.Model;
              })}
            />
          ))}
          {renderField('model-runtime', 'NumCtx', (
            <input
              type="number"
              value={dashboardConfig.Runtime.LlamaCpp.NumCtx}
              onChange={(event) => updateSettingsDraft((next) => {
                const value = parseIntegerInput(event.target.value, next.Runtime.LlamaCpp.NumCtx);
                next.Runtime.LlamaCpp.NumCtx = value;
                next.LlamaCpp.NumCtx = value;
              })}
            />
          ))}
          {renderField('model-runtime', 'MaxTokens', (
            <input
              type="number"
              value={dashboardConfig.Runtime.LlamaCpp.MaxTokens}
              onChange={(event) => updateSettingsDraft((next) => {
                const value = parseIntegerInput(event.target.value, next.Runtime.LlamaCpp.MaxTokens);
                next.Runtime.LlamaCpp.MaxTokens = value;
                next.LlamaCpp.MaxTokens = value;
              })}
            />
          ))}
          {renderField('model-runtime', 'Threads', (
            <input
              type="number"
              value={dashboardConfig.Runtime.LlamaCpp.Threads}
              onChange={(event) => updateSettingsDraft((next) => {
                const value = parseIntegerInput(event.target.value, next.Runtime.LlamaCpp.Threads);
                next.Runtime.LlamaCpp.Threads = value;
                next.LlamaCpp.Threads = value;
              })}
            />
          ))}
          {renderField('model-runtime', 'GpuLayers', (
            <input
              type="number"
              value={dashboardConfig.Runtime.LlamaCpp.GpuLayers}
              onChange={(event) => updateSettingsDraft((next) => {
                const value = parseIntegerInput(event.target.value, next.Runtime.LlamaCpp.GpuLayers);
                next.Runtime.LlamaCpp.GpuLayers = value;
                next.LlamaCpp.GpuLayers = value;
              })}
            />
          ))}
          {renderField('model-runtime', 'Flash attention', (
            <label className="settings-live-toggle-control">
              <input
                type="checkbox"
                checked={dashboardConfig.Runtime.LlamaCpp.FlashAttention}
                onChange={(event) => updateSettingsDraft((next) => {
                  next.Runtime.LlamaCpp.FlashAttention = event.target.checked;
                  next.LlamaCpp.FlashAttention = event.target.checked;
                })}
              />
              <span>{dashboardConfig.Runtime.LlamaCpp.FlashAttention ? 'Enabled' : 'Disabled'}</span>
            </label>
          ))}
        </div>
      );
    }

    if (activeSettingsSection === 'sampling') {
      return (
        <div className="settings-live-grid">
          {renderField('sampling', 'Temperature', (
            <input
              type="number"
              step="0.01"
              value={dashboardConfig.Runtime.LlamaCpp.Temperature}
              onChange={(event) => updateSettingsDraft((next) => {
                const value = parseFloatInput(event.target.value, next.Runtime.LlamaCpp.Temperature);
                next.Runtime.LlamaCpp.Temperature = value;
                next.LlamaCpp.Temperature = value;
              })}
            />
          ))}
          {renderField('sampling', 'TopP', (
            <input
              type="number"
              step="0.01"
              value={dashboardConfig.Runtime.LlamaCpp.TopP}
              onChange={(event) => updateSettingsDraft((next) => {
                const value = parseFloatInput(event.target.value, next.Runtime.LlamaCpp.TopP);
                next.Runtime.LlamaCpp.TopP = value;
                next.LlamaCpp.TopP = value;
              })}
            />
          ))}
          {renderField('sampling', 'TopK', (
            <input
              type="number"
              value={dashboardConfig.Runtime.LlamaCpp.TopK}
              onChange={(event) => updateSettingsDraft((next) => {
                const value = parseIntegerInput(event.target.value, next.Runtime.LlamaCpp.TopK);
                next.Runtime.LlamaCpp.TopK = value;
                next.LlamaCpp.TopK = value;
              })}
            />
          ))}
          {renderField('sampling', 'MinP', (
            <input
              type="number"
              step="0.01"
              value={dashboardConfig.Runtime.LlamaCpp.MinP}
              onChange={(event) => updateSettingsDraft((next) => {
                const value = parseFloatInput(event.target.value, next.Runtime.LlamaCpp.MinP);
                next.Runtime.LlamaCpp.MinP = value;
                next.LlamaCpp.MinP = value;
              })}
            />
          ))}
          {renderField('sampling', 'PresencePenalty', (
            <input
              type="number"
              step="0.01"
              value={dashboardConfig.Runtime.LlamaCpp.PresencePenalty}
              onChange={(event) => updateSettingsDraft((next) => {
                const value = parseFloatInput(event.target.value, next.Runtime.LlamaCpp.PresencePenalty);
                next.Runtime.LlamaCpp.PresencePenalty = value;
                next.LlamaCpp.PresencePenalty = value;
              })}
            />
          ))}
          {renderField('sampling', 'RepetitionPenalty', (
            <input
              type="number"
              step="0.01"
              value={dashboardConfig.Runtime.LlamaCpp.RepetitionPenalty}
              onChange={(event) => updateSettingsDraft((next) => {
                const value = parseFloatInput(event.target.value, next.Runtime.LlamaCpp.RepetitionPenalty);
                next.Runtime.LlamaCpp.RepetitionPenalty = value;
                next.LlamaCpp.RepetitionPenalty = value;
              })}
            />
          ))}
          {renderField('sampling', 'ParallelSlots', (
            <input
              type="number"
              value={dashboardConfig.Runtime.LlamaCpp.ParallelSlots}
              onChange={(event) => updateSettingsDraft((next) => {
                const value = parseIntegerInput(event.target.value, next.Runtime.LlamaCpp.ParallelSlots);
                next.Runtime.LlamaCpp.ParallelSlots = value;
                next.LlamaCpp.ParallelSlots = value;
              })}
            />
          ))}
          {renderField('sampling', 'Reasoning', (
            <select
              value={dashboardConfig.Runtime.LlamaCpp.Reasoning}
              onChange={(event) => updateSettingsDraft((next) => {
                const value = event.target.value as 'on' | 'off' | 'auto';
                next.Runtime.LlamaCpp.Reasoning = value;
                next.LlamaCpp.Reasoning = value;
              })}
            >
              <option value="off">off</option>
              <option value="on">on</option>
              <option value="auto">auto</option>
            </select>
          ))}
        </div>
      );
    }

    if (activeSettingsSection === 'interactive') {
      return (
        <div className="settings-live-grid">
          {renderField('interactive', 'MinCharsForSummary', (
            <input
              type="number"
              value={dashboardConfig.Thresholds.MinCharactersForSummary}
              onChange={(event) => updateSettingsDraft((next) => {
                next.Thresholds.MinCharactersForSummary = parseIntegerInput(event.target.value, next.Thresholds.MinCharactersForSummary);
              })}
            />
          ))}
          {renderField('interactive', 'MinLinesForSummary', (
            <input
              type="number"
              value={dashboardConfig.Thresholds.MinLinesForSummary}
              onChange={(event) => updateSettingsDraft((next) => {
                next.Thresholds.MinLinesForSummary = parseIntegerInput(event.target.value, next.Thresholds.MinLinesForSummary);
              })}
            />
          ))}
          {renderField('interactive', 'Interactive IdleTimeoutMs', (
            <input
              type="number"
              value={dashboardConfig.Interactive.IdleTimeoutMs}
              onChange={(event) => updateSettingsDraft((next) => {
                next.Interactive.IdleTimeoutMs = parseIntegerInput(event.target.value, next.Interactive.IdleTimeoutMs);
              })}
            />
          ))}
          {renderField('interactive', 'MaxTranscriptChars', (
            <input
              type="number"
              value={dashboardConfig.Interactive.MaxTranscriptCharacters}
              onChange={(event) => updateSettingsDraft((next) => {
                next.Interactive.MaxTranscriptCharacters = parseIntegerInput(event.target.value, next.Interactive.MaxTranscriptCharacters);
              })}
            />
          ))}
          {renderField('interactive', 'Wrapped commands', (
            <textarea
              rows={4}
              value={dashboardConfig.Interactive.WrappedCommands.join(', ')}
              onChange={(event) => updateSettingsDraft((next) => {
                next.Interactive.WrappedCommands = event.target.value
                  .split(',')
                  .map((entry) => entry.trim())
                  .filter(Boolean);
              })}
            />
          ))}
          {renderField('interactive', 'Interactive enabled', (
            <label className="settings-live-toggle-control">
              <input
                type="checkbox"
                checked={dashboardConfig.Interactive.Enabled}
                onChange={(event) => updateSettingsDraft((next) => { next.Interactive.Enabled = event.target.checked; })}
              />
              <span>{dashboardConfig.Interactive.Enabled ? 'Enabled' : 'Disabled'}</span>
            </label>
          ))}
          {renderField('interactive', 'Interactive transcript retention', (
            <label className="settings-live-toggle-control">
              <input
                type="checkbox"
                checked={dashboardConfig.Interactive.TranscriptRetention}
                onChange={(event) => updateSettingsDraft((next) => { next.Interactive.TranscriptRetention = event.target.checked; })}
              />
              <span>{dashboardConfig.Interactive.TranscriptRetention ? 'Enabled' : 'Disabled'}</span>
            </label>
          ))}
        </div>
      );
    }

    return (
      <div className="settings-live-grid">
        {renderField('managed-llama', 'Startup script path', (
          <input
            value={dashboardConfig.Server.LlamaCpp.StartupScript || ''}
            onChange={(event) => updateSettingsDraft((next) => {
              const value = event.target.value.trim();
              next.Server.LlamaCpp.StartupScript = value || null;
            })}
          />
        ))}
        {renderField('managed-llama', 'Shutdown script path', (
          <input
            value={dashboardConfig.Server.LlamaCpp.ShutdownScript || ''}
            onChange={(event) => updateSettingsDraft((next) => {
              const value = event.target.value.trim();
              next.Server.LlamaCpp.ShutdownScript = value || null;
            })}
          />
        ))}
        {renderField('managed-llama', 'StartupTimeoutMs', (
          <input
            type="number"
            value={dashboardConfig.Server.LlamaCpp.StartupTimeoutMs}
            onChange={(event) => updateSettingsDraft((next) => {
              next.Server.LlamaCpp.StartupTimeoutMs = parseIntegerInput(event.target.value, next.Server.LlamaCpp.StartupTimeoutMs);
            })}
          />
        ))}
        {renderField('managed-llama', 'HealthcheckTimeoutMs', (
          <input
            type="number"
            value={dashboardConfig.Server.LlamaCpp.HealthcheckTimeoutMs}
            onChange={(event) => updateSettingsDraft((next) => {
              next.Server.LlamaCpp.HealthcheckTimeoutMs = parseIntegerInput(event.target.value, next.Server.LlamaCpp.HealthcheckTimeoutMs);
            })}
          />
        ))}
        {renderField('managed-llama', 'HealthcheckIntervalMs', (
          <input
            type="number"
            value={dashboardConfig.Server.LlamaCpp.HealthcheckIntervalMs}
            onChange={(event) => updateSettingsDraft((next) => {
              next.Server.LlamaCpp.HealthcheckIntervalMs = parseIntegerInput(event.target.value, next.Server.LlamaCpp.HealthcheckIntervalMs);
            })}
          />
        ))}
        {renderField('managed-llama', 'Managed llama verbose logging', (
          <label className="settings-live-toggle-control">
            <input
              type="checkbox"
              checked={dashboardConfig.Server.LlamaCpp.VerboseLogging}
              onChange={(event) => updateSettingsDraft((next) => { next.Server.LlamaCpp.VerboseLogging = event.target.checked; })}
            />
            <span>{dashboardConfig.Server.LlamaCpp.VerboseLogging ? 'Enabled' : 'Disabled'}</span>
          </label>
        ))}
        {renderField('managed-llama', 'Additional llama.cpp args', (
          <textarea
            rows={4}
            value={dashboardConfig.Server.LlamaCpp.VerboseArgs.join(', ')}
            onChange={(event) => updateSettingsDraft((next) => {
              next.Server.LlamaCpp.VerboseArgs = event.target.value
                .split(',')
                .map((entry) => entry.trim())
                .filter(Boolean);
            })}
          />
        ))}
      </div>
    );
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
        <section className="panel-grid">
          <section className="panel">
            <div className="filters">
              <div className="run-filter-toolbar">
                <input placeholder="Search runs" value={search} onChange={(event) => setSearch(event.target.value)} />
                <button type="button" className="run-delete-button" onClick={openRunDeleteModal}>
                  Delete Logs
                </button>
              </div>
              <input placeholder="Status filter" value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)} />
              <div className="filter-pill-row">
                <span className="filter-pill-label">Type</span>
                {RUN_LOG_TYPE_PRESETS.map((preset) => (
                  <button
                    key={preset.label}
                    type="button"
                    className={`filter-pill kind ${preset.tone} ${kindFilter === preset.value ? 'active' : ''}`}
                    onClick={() => setKindFilter((previous) => toggleRunLogTypeFilter(previous, preset.value))}
                  >
                    {preset.label}
                  </button>
                ))}
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
                    {sortedToolMetricRows.map((entry) => {
                        const avgChars = entry.calls > 0 ? Math.round(entry.outputCharsTotal / entry.calls) : 0;
                        const avgTokens = entry.calls > 0 ? Math.round(entry.outputTokensTotal / entry.calls) : 0;
                        const avgLines = entry.lineReadCalls > 0 ? Math.round(entry.lineReadLinesTotal / entry.lineReadCalls) : 0;
                        const avgTokensPerLine = entry.lineReadLinesTotal > 0 ? entry.lineReadTokensTotal / entry.lineReadLinesTotal : null;
                        const estimatedRate = entry.calls > 0 ? (entry.outputTokensEstimatedCount / entry.calls) * 100 : 0;
                        const insertedAvgTokens = entry.calls > 0 ? Math.round(entry.promptInsertedTokens / entry.calls) : 0;
                        const rawAvgTokens = entry.calls > 0 ? Math.round(entry.rawToolResultTokens / entry.calls) : 0;
                        return (
                          <article
                            key={`${entry.taskKind}-${entry.toolType}`}
                            className={`idle-card idle-metric-card metric-tool task-kind-${formatTaskKindClass(entry.taskKind)}`}
                            title={describeToolType(entry.toolType)}
                          >
                            <span>{formatTaskKindLabel(entry.taskKind)}</span>
                            <strong>{entry.toolType}</strong>
                            <span>Calls: {formatNumber(entry.calls)}</span>
                            <span>Avg chars: {formatNumber(avgChars)}</span>
                            <span>Avg tokens: {formatNumber(avgTokens)}</span>
                            {(entry.promptInsertedTokens > 0 || entry.rawToolResultTokens > 0) && (
                              <span>Avg inserted/raw tok: {formatNumber(insertedAvgTokens)} / {formatNumber(rawAvgTokens)}</span>
                            )}
                            {(entry.lineReadCalls > 0 || entry.lineReadRecommendedLines !== null) && (
                              <span>Avg lines/read: {formatNumber(avgLines)}</span>
                            )}
                            {(entry.lineReadLinesTotal > 0 || entry.lineReadRecommendedLines !== null) && (
                              <span>Avg tokens/line: {avgTokensPerLine === null ? '-' : avgTokensPerLine.toFixed(2)}</span>
                            )}
                            {entry.lineReadRecommendedLines !== null && (
                              <span>Recommended lines: {formatNumber(entry.lineReadRecommendedLines)}</span>
                            )}
                            {entry.lineReadAllowanceTokens !== null && (
                              <span>Allowance: {formatNumber(entry.lineReadAllowanceTokens)} tok</span>
                            )}
                            {(entry.finishRejections > 0 || entry.semanticRepeatRejects > 0 || entry.stagnationWarnings > 0 || entry.forcedFinishFromStagnation > 0) && (
                              <span>Finish/Repeat/Stall/Forced: {formatNumber(entry.finishRejections)} / {formatNumber(entry.semanticRepeatRejects)} / {formatNumber(entry.stagnationWarnings)} / {formatNumber(entry.forcedFinishFromStagnation)}</span>
                            )}
                            {(entry.newEvidenceCalls > 0 || entry.noNewEvidenceCalls > 0) && (
                              <span>New / stale evidence: {formatNumber(entry.newEvidenceCalls)} / {formatNumber(entry.noNewEvidenceCalls)}</span>
                            )}
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
            {taskRunsGraphSeries.length > 0 ? (
              <InteractiveGraph
                storageId="per-task-daily-runs"
                title="Per-Task Daily Metrics (Runs)"
                series={taskRunsGraphSeries}
              />
            ) : (
              <p className="hint">No per-task metrics available yet.</p>
            )}
          </section>
        </section>
      )}

      {tab === 'settings' && (
        <section className="panel-grid settings-live-layout">
          <section className="panel settings-live-rail-panel">
            <h2>Settings</h2>
            <p className="hint">One section at a time. Unsaved changes are guarded before switching away.</p>
            <div className="settings-live-rail">
              {SETTINGS_SECTION_ORDER.map((sectionId) => {
                const section = SETTINGS_SECTIONS[sectionId];
                return (
                  <button
                    key={section.id}
                    type="button"
                    className={activeSettingsSection === section.id ? 'settings-live-rail-button active' : 'settings-live-rail-button'}
                    onClick={() => {
                      if (activeSettingsSection === section.id) {
                        return;
                      }
                      requestSettingsAction({ kind: 'switch-section', nextSection: section.id });
                    }}
                  >
                    <span className="settings-live-section-icon">{section.icon}</span>
                    <span>
                      <strong>{section.title}</strong>
                      <span>{section.summary}</span>
                    </span>
                  </button>
                );
              })}
            </div>
          </section>
          <section className="panel settings-live-panel">
            {settingsLoading && <p className="hint">Loading config...</p>}
            {settingsError && <p className="error">{settingsError}</p>}
            {dashboardConfig && (
              <>
                <div className="settings-live-section-header">
                  <div>
                    <span className="settings-live-section-icon active">{SETTINGS_SECTIONS[activeSettingsSection].icon}</span>
                    <div>
                      <h2>{SETTINGS_SECTIONS[activeSettingsSection].title}</h2>
                      <p className="hint">{SETTINGS_SECTIONS[activeSettingsSection].summary}</p>
                    </div>
                  </div>
                  <div className="settings-live-status">
                    <span className={settingsDirty ? 'settings-live-dirty on' : 'settings-live-dirty'}>
                      {settingsDirty ? 'Unsaved changes' : 'All changes saved'}
                    </span>
                    {settingsSavedAtUtc && <span className="hint">Saved {formatDate(settingsSavedAtUtc)}</span>}
                  </div>
                </div>
                <div className="settings-live-section-body">
                  {renderSettingsSection()}
                </div>
                <div className="settings-live-actionbar">
                  <button
                    type="button"
                    onClick={() => {
                      if (settingsDirty) {
                        requestSettingsAction({ kind: 'reload-settings' });
                        return;
                      }
                      void onReloadDashboardSettings();
                    }}
                    disabled={settingsActionBusy}
                  >
                    Reload
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      if (settingsDirty) {
                        requestSettingsAction({ kind: 'restart-backend' });
                        return;
                      }
                      void restartDashboardBackendCore();
                    }}
                    disabled={settingsActionBusy || !settingsRestartSupported}
                  >
                    {settingsRestarting ? 'Restarting...' : 'Restart Backend'}
                  </button>
                  <button
                    type="button"
                    className="settings-live-save-button"
                    onClick={() => { void onSaveDashboardSettings(); }}
                    disabled={settingsActionBusy}
                  >
                    {settingsSaving ? 'Saving...' : 'Save Settings'}
                  </button>
                </div>
              </>
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
                  <select
                    value={selectedChatPreset?.id || ''}
                    onChange={(event) => { void onUpdateSessionPreset(event.target.value); }}
                    disabled={chatBusy || webPresets.length === 0}
                  >
                    {webPresets.length === 0 ? <option value="">No presets</option> : null}
                    {webPresets.map((preset) => (
                      <option key={preset.id} value={preset.id}>
                        {preset.label}
                      </option>
                    ))}
                  </select>
                  {selectedChatPreset ? (
                    <span className="hint settings-summary" title={selectedChatPreset.description}>
                      {selectedChatPreset.presetKind} | {selectedChatPreset.operationMode}
                    </span>
                  ) : null}
                  {isRepoToolMode && !showSettings && (
                    <span className="hint settings-summary" title="Click the gear icon to adjust">
                      {planMaxTurnsInput ? `${planMaxTurnsInput} turns` : ''}{planMaxTurnsInput && planThinkingIntervalInput ? ', ' : ''}{planThinkingIntervalInput ? `think every ${planThinkingIntervalInput}` : ''}
                    </span>
                  )}
                </div>
                {showSettings && (
                  <>
                    {isDirectChatMode ? (
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
                    {isRepoToolMode ? (
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
                    {isRepoToolMode ? (
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
                        {isRepoToolMode && Number.isFinite(liveToolPromptTokenCount) ? (
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
                      {isDirectChatMode && message.role === 'assistant' && message.thinkingContent ? (
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
                    {((isDirectChatMode && isThinkingEnabledForCurrentSession) || (isRepoToolMode && thinkingDraft)) && (
                      <section className="live-box thinking">
                        <h3>{chatMode === 'plan' ? 'Plan Thinking' : chatMode === 'repo-search' ? 'Search Thinking' : chatMode === 'summary' ? 'Summary Thinking' : 'Thinking'}</h3>
                        <pre>{thinkingDraft || '...'}</pre>
                      </section>
                    )}
                    {isRepoToolMode && planToolCalls.length > 0 && (
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
                    {(isDirectChatMode || chatMode === 'repo-search') && (
                      <section className="live-box answer">
                        <h3>{chatMode === 'repo-search' ? 'Search Thinking' : chatMode === 'summary' ? 'Summary' : 'Answer'}</h3>
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
                    placeholder={chatMode === 'plan' ? 'Describe the feature to plan (plan mode runs repo-search)...' : chatMode === 'repo-search' ? 'Enter a repo search query...' : chatMode === 'summary' ? 'Enter a summary request...' : 'Send a local chat message...'}
                    value={chatInput}
                    onChange={(event) => setChatInput(event.target.value)}
                    rows={4}
                  />
                  <button onClick={() => { if (chatMode === 'plan') { void onSendPlan(); return; } if (chatMode === 'repo-search') { void onSendRepoSearch(); return; } void onSendMessage(); }} disabled={chatBusy || !chatInput.trim()}>
                    {chatMode === 'plan' ? 'Generate Plan' : chatMode === 'repo-search' ? 'Search' : chatMode === 'summary' ? 'Summarize' : 'Send'}
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

import { randomUUID } from 'node:crypto';
import {
  getConfiguredLlamaBaseUrl,
  getConfiguredLlamaNumCtx,
  getConfiguredLlamaSetting,
  getConfiguredModel,
  loadConfig,
  type SiftConfig,
} from '../config/index.js';
import {
  createEmptyToolTypeStats,
  getRepoSearchLineReadStats,
  getRepoSearchPromptBaselinePerToolAllowanceTokens,
  mergeToolTypeStats,
  readLatestIdleSummaryToolStats,
} from '../line-read-guidance.js';
import { spawnPowerShellAsync } from '../lib/powershell.js';
import { colorize } from '../lib/text-format.js';
import { countLlamaCppTokens, listLlamaCppModels } from '../providers/llama-cpp.js';
import type { ToolTypeStats } from '../status-server/metrics.js';
import {
  buildIgnorePolicy,
  evaluateCommandSafety,
  getFirstCommandToken,
  isSearchNoMatchExit,
  normalizePlannerCommand,
} from './command-safety.js';
import {
  getRepoSearchCommandTokenForToolName,
  isRepoSearchCommandToolName,
  resolveRepoSearchPlannerToolDefinitions,
  parsePlannerAction,
  renderTaskTranscript,
  requestPlannerAction,
  requestTerminalSynthesis,
  type ChatMessage,
  type PlannerActionResponse,
} from './planner-protocol.js';
import {
  compactPlannerMessagesOnce,
  countTokensWithFallback,
  estimateTokenCount,
  preflightPlannerPromptBudget,
} from './prompt-budget.js';
import {
  buildTaskInitialUserPrompt,
  buildTaskSystemPrompt,
  buildTerminalSynthesisFallback,
  buildTerminalSynthesisPrompt,
  scanRepoFiles,
  type HistoryEntry,
  type TaskCommand,
} from './prompts.js';
import {
  buildRepeatedToolCallSummary,
  buildPromptToolResult,
  buildToolReplayFingerprint,
  classifyToolResultNovelty,
  evaluateFinishAttempt,
  fingerprintToolCall,
} from '../tool-loop-governor.js';
import type {
  JsonLogger,
  RepoSearchMockCommandResult,
  RepoSearchProgressEvent,
} from './types.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_MAX_TURNS = 45;
const DEFAULT_MAX_INVALID_RESPONSES = 3;
const DEFAULT_TIMEOUT_MS = 120_000;
const MIN_TOOL_CALLS_BEFORE_FINISH = 5;
const THINKING_BUFFER_RATIO = 0.15;
const THINKING_BUFFER_MIN_TOKENS = 4000;
const PER_TOOL_RESULT_RATIO = 0.10;
const DEFAULT_REPO_SEARCH_REQUEST_MAX_TOKENS = 2048;
const ZERO_OUTPUT_FORCE_THRESHOLD = 10;
const NON_THINKING_FINISH_AUTO_ACCEPT_TOOL_CALL_THRESHOLD = 10;
const FORCED_FINISH_MAX_ATTEMPTS = 3;
const STAGNATION_WARNING_THRESHOLD = 3;
const STAGNATION_FORCE_THRESHOLD = 4;
const NON_THINKING_FINISH_FOLLOWUP_PROMPT = 'Are you sure you have everything? If yes, only respond with `yes I am sure`. If not, keep using tool calls to investigate more.';
const ANSI_RED_CODE = 31;

// ---------------------------------------------------------------------------
// Slot allocation
// ---------------------------------------------------------------------------

let nextLlamaCppSlotId = 0;

function allocateLlamaCppSlotId(config: SiftConfig): number {
  const configuredSlots = getConfiguredLlamaSetting<number>(config, 'ParallelSlots');
  const slotCount = Math.max(1, Math.floor(Number(configuredSlots) || 1));
  const slotId = nextLlamaCppSlotId % slotCount;
  nextLlamaCppSlotId = (nextLlamaCppSlotId + 1) % slotCount;
  return slotId;
}

// ---------------------------------------------------------------------------
// Task definitions (built-in self-test pack)
// ---------------------------------------------------------------------------

export type TaskDefinition = {
  id: string;
  question: string;
  signals: string[];
};

export const TASK_PACK: TaskDefinition[] = [
  {
    id: 'symbol-location',
    question: 'Find where buildPlannerToolDefinitions is defined. Return file path and nearby signature text.',
    signals: ['src[\\\\/]summary\\.ts', 'buildPlannerToolDefinitions'],
  },
  {
    id: 'call-path',
    question: 'Find what function invokes invokePlannerMode in summary flow. Return caller function name.',
    signals: ['invokePlannerMode', 'invokeSummaryCore'],
  },
  {
    id: 'config-runtime-key',
    question: 'Find where getConfiguredLlamaNumCtx is defined and at least one usage site.',
    signals: ['src[\\\\/]config\\.ts', 'getConfiguredLlamaNumCtx'],
  },
  {
    id: 'planner-tools',
    question: 'Find planner tool names in SiftKit and list them.',
    signals: ['find_text', 'read_lines', 'json_filter'],
  },
  {
    id: 'debug-artifacts',
    question: 'Find where planner debug dumps are written and show filename pattern.',
    signals: ['planner_debug_', 'getRuntimeLogsPath'],
  },
];

// ---------------------------------------------------------------------------
// Command execution
// ---------------------------------------------------------------------------

function findMockResult(
  command: string,
  mockCommandResults: Record<string, RepoSearchMockCommandResult>,
): RepoSearchMockCommandResult | null {
  if (Object.prototype.hasOwnProperty.call(mockCommandResults, command)) {
    return mockCommandResults[command];
  }
  // Prefix match: find the longest mock key that the command starts with.
  // This allows mock keys to omit auto-appended flags (--no-ignore, --glob, etc.)
  let bestKey: string | null = null;
  for (const key of Object.keys(mockCommandResults)) {
    if (command.startsWith(key) && (!bestKey || key.length > bestKey.length)) {
      bestKey = key;
    }
  }
  return bestKey ? mockCommandResults[bestKey] : null;
}

function executeRepoCommand(
  command: string,
  repoRoot: string,
  mockCommandResults: Record<string, RepoSearchMockCommandResult> | null,
): Promise<{ exitCode: number; output: string }> {
  const mockResult = mockCommandResults ? findMockResult(command, mockCommandResults) : null;
  if (mockResult) {
    const delayMs = Number(mockResult.delayMs ?? 0);
    return new Promise((resolve) => {
      const complete = (): void => resolve({
        exitCode: Number(mockResult.exitCode ?? 1),
        output: `${String(mockResult.stdout || '')}${String(mockResult.stderr || '')}`.trim(),
      });
      if (Number.isFinite(delayMs) && delayMs > 0) {
        setTimeout(complete, delayMs);
      } else {
        complete();
      }
    });
  }

  return spawnPowerShellAsync(command, { cwd: repoRoot }).then((result) => ({
    exitCode: result.exitCode,
    output: result.output,
  }));
}

function normalizeToolTypeFromCommand(command: string): string {
  const trimmed = String(command || '').trim();
  if (!trimmed) {
    return 'unknown';
  }
  const match = /^"([^"]+)"|^'([^']+)'|^([^\s]+)/u.exec(trimmed);
  const firstToken = (match?.[1] || match?.[2] || match?.[3] || '').trim();
  if (!firstToken) {
    return 'unknown';
  }
  const normalized = firstToken.replace(/^[\\/]+/u, '').replace(/[\\/]+$/u, '');
  const parts = normalized.split(/[\\/]/u).filter(Boolean);
  const family = (parts[parts.length - 1] || normalized || 'unknown').trim().toLowerCase();
  return family || 'unknown';
}

// ---------------------------------------------------------------------------
// Signal evaluation
// ---------------------------------------------------------------------------

function evaluateTaskSignals(task: TaskDefinition, evidenceText: string): {
  passed: boolean;
  missingSignals: string[];
} {
  const missingSignals: string[] = [];
  for (const signal of task.signals) {
    const regex = new RegExp(signal, 'iu');
    if (!regex.test(evidenceText)) {
      missingSignals.push(signal);
    }
  }
  return { passed: missingSignals.length === 0, missingSignals };
}

// ---------------------------------------------------------------------------
// Request max-tokens resolution
// ---------------------------------------------------------------------------

export function resolveRepoSearchRequestMaxTokens(options: {
  config?: SiftConfig;
  requestMaxTokens?: number;
} = {}): number {
  const explicitMaxTokens = Number(options.requestMaxTokens);
  if (Number.isFinite(explicitMaxTokens) && explicitMaxTokens > 0) {
    return Math.floor(explicitMaxTokens);
  }
  const configuredMaxTokens = Number(getConfiguredLlamaSetting(options.config || {} as SiftConfig, 'MaxTokens'));
  if (Number.isFinite(configuredMaxTokens) && configuredMaxTokens > 0) {
    return Math.floor(Math.min(configuredMaxTokens, DEFAULT_REPO_SEARCH_REQUEST_MAX_TOKENS));
  }
  return DEFAULT_REPO_SEARCH_REQUEST_MAX_TOKENS;
}

// ---------------------------------------------------------------------------
// Console helper
// ---------------------------------------------------------------------------

function writeRedConsoleLine(message: string): void {
  if (!message) return;
  process.stderr.write(`${colorize(String(message), ANSI_RED_CODE, { isTTY: true })}\n`);
}

function normalizeResponseToken(token: string): string {
  return String(token || '').trim().toLowerCase().replace(/^[^a-z0-9]+|[^a-z0-9]+$/gu, '');
}

function isFollowupConfirmationResponse(text: string): boolean {
  const trimmed = String(text || '').trim();
  if (!trimmed) {
    return false;
  }
  if (trimmed.toLowerCase() === 'yes i am sure') {
    return true;
  }
  const firstTenWords = trimmed.split(/\s+/u).slice(0, 10).map(normalizeResponseToken).filter(Boolean);
  return firstTenWords.includes('yes') && firstTenWords.includes('sure');
}

const REPEATED_LINE_READ_MIN_RATIO = 0.10;
const DEFAULT_LINE_READ_AVG_TOKENS_PER_LINE = 8.0;
const LINE_READ_ROUNDING_STEP = 10;

type ParsedGetContentReadWindow = {
  pathKey: string;
  pathExpression: string;
  requestedSkip: number;
  requestedFirst: number;
  requestedStart: number;
  requestedEnd: number;
  hasExplicitSkip: boolean;
};

type LineReadAdjustment = {
  executedCommand: string;
  requestedStart: number;
  requestedEnd: number;
  adjustedStart: number;
  adjustedEnd: number;
  minLinesFromCap: number;
  perToolCapTokens: number;
  reason: string;
};

type ReadRange = {
  start: number;
  end: number;
};

type ReadWindow = {
  turn: number;
  requestedStart: number; // inclusive
  requestedEnd: number; // exclusive
  executedStart: number; // inclusive
  executedEnd: number; // exclusive
  adjusted: boolean;
};

type FileReadState = {
  windows: ReadWindow[];
  mergedExecutedRanges: ReadRange[];
  totalLinesRead: number;
  uniqueLinesRead: number;
  overlapLines: number;
};

export type ReadOverlapSummary = {
  byFile: Array<{
    pathKey: string;
    totalLinesRead: number;
    uniqueLinesRead: number;
    overlapLines: number;
    overlapRatePct: number;
  }>;
  totalLinesRead: number;
  totalUniqueLinesRead: number;
  totalOverlapLines: number;
  overlapRatePct: number;
};

function tokenizeShellLike(input: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let inSingle = false;
  let inDouble = false;
  for (let index = 0; index < input.length; index += 1) {
    const ch = input[index];
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
      current += ch;
      continue;
    }
    if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
      current += ch;
      continue;
    }
    if (/\s/u.test(ch) && !inSingle && !inDouble) {
      if (current) {
        tokens.push(current);
        current = '';
      }
      continue;
    }
    current += ch;
  }
  if (current) {
    tokens.push(current);
  }
  return tokens;
}

function stripOuterQuotes(value: string): string {
  const trimmed = String(value || '').trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function normalizeReadPathKey(pathValue: string): string {
  return stripOuterQuotes(pathValue).replace(/\//gu, '\\').toLowerCase();
}

function roundToNearestStep(value: number, step: number): number {
  if (!Number.isFinite(value) || !Number.isFinite(step) || step <= 0) {
    return Math.floor(Number(value) || 0);
  }
  return Math.round(value / step) * step;
}

function roundUpToStep(value: number, step: number): number {
  if (!Number.isFinite(value) || !Number.isFinite(step) || step <= 0) {
    return Math.floor(Number(value) || 0);
  }
  return Math.ceil(value / step) * step;
}

function normalizeRange(range: ReadRange): ReadRange {
  const start = Math.max(0, Math.floor(Number(range.start) || 0));
  const end = Math.max(start, Math.floor(Number(range.end) || 0));
  return { start, end };
}

function intersectionLength(a: ReadRange, b: ReadRange): number {
  const normalizedA = normalizeRange(a);
  const normalizedB = normalizeRange(b);
  const intersectionStart = Math.max(normalizedA.start, normalizedB.start);
  const intersectionEnd = Math.min(normalizedA.end, normalizedB.end);
  return intersectionEnd > intersectionStart ? (intersectionEnd - intersectionStart) : 0;
}

function overlapWithRanges(ranges: ReadRange[], next: ReadRange): number {
  const normalizedNext = normalizeRange(next);
  let overlapLines = 0;
  for (const range of ranges) {
    overlapLines += intersectionLength(range, normalizedNext);
  }
  return overlapLines;
}

function mergeRange(ranges: ReadRange[], next: ReadRange): ReadRange[] {
  const normalizedNext = normalizeRange(next);
  if (normalizedNext.end <= normalizedNext.start) {
    return [...ranges];
  }
  const sortedRanges = [...ranges.map(normalizeRange), normalizedNext]
    .filter((range) => range.end > range.start)
    .sort((left, right) => (left.start - right.start) || (left.end - right.end));
  if (sortedRanges.length === 0) {
    return [];
  }
  const merged: ReadRange[] = [];
  for (const currentRange of sortedRanges) {
    const lastRange = merged[merged.length - 1];
    if (!lastRange || currentRange.start > lastRange.end) {
      merged.push({ ...currentRange });
      continue;
    }
    if (currentRange.end > lastRange.end) {
      lastRange.end = currentRange.end;
    }
  }
  return merged;
}

function getOrCreateFileReadState(fileReadStateByPath: Map<string, FileReadState>, pathKey: string): FileReadState {
  const existingState = fileReadStateByPath.get(pathKey);
  if (existingState) {
    return existingState;
  }
  const createdState: FileReadState = {
    windows: [],
    mergedExecutedRanges: [],
    totalLinesRead: 0,
    uniqueLinesRead: 0,
    overlapLines: 0,
  };
  fileReadStateByPath.set(pathKey, createdState);
  return createdState;
}

function getPreviousExecutedMaxEnd(fileReadState: FileReadState): number {
  if (fileReadState.mergedExecutedRanges.length === 0) {
    return 0;
  }
  return Math.max(...fileReadState.mergedExecutedRanges.map((range) => range.end));
}

function computeAdjustedReadWindow(input: {
  requestedStart: number;
  requestedEnd: number;
  minLinesFromCap: number;
  roundingStep: number;
  previousExecutedMaxEnd: number;
}): { start: number; end: number; adjusted: boolean; reason: string } {
  const requestedStart = Math.max(0, Math.floor(Number(input.requestedStart) || 0));
  const requestedEnd = Math.max(requestedStart + 1, Math.floor(Number(input.requestedEnd) || 0));
  const requestedLength = Math.max(1, requestedEnd - requestedStart);
  const nonOverlapStart = Math.max(requestedStart, Math.floor(Number(input.previousExecutedMaxEnd) || 0));
  const targetLength = Math.max(requestedLength, Math.max(1, Math.floor(Number(input.minLinesFromCap) || 0)));
  let start = Math.max(0, roundUpToStep(nonOverlapStart, input.roundingStep));
  if (start < nonOverlapStart) {
    start = nonOverlapStart;
  }
  let end = roundToNearestStep(start + targetLength, input.roundingStep);
  if (end <= start) {
    end = start + Math.max(1, Math.floor(Number(input.roundingStep) || 1));
  }
  while (end - start < targetLength) {
    end += Math.max(1, Math.floor(Number(input.roundingStep) || 1));
  }
  return {
    start,
    end,
    adjusted: start !== requestedStart || end !== requestedEnd,
    reason: 'repeated-read-no-overlap',
  };
}

function buildReadOverlapSummary(fileReadStateByPath: Map<string, FileReadState>): ReadOverlapSummary {
  const byFile = Array.from(fileReadStateByPath.entries())
    .map(([pathKey, state]) => {
      const totalLinesRead = Number(state.totalLinesRead || 0);
      const uniqueLinesRead = Number(state.uniqueLinesRead || 0);
      const overlapLines = Number(state.overlapLines || 0);
      const overlapRatePct = totalLinesRead > 0 ? Number(((overlapLines / totalLinesRead) * 100).toFixed(2)) : 0;
      return {
        pathKey,
        totalLinesRead,
        uniqueLinesRead,
        overlapLines,
        overlapRatePct,
      };
    })
    .sort((left, right) => left.pathKey.localeCompare(right.pathKey));
  const totalLinesRead = byFile.reduce((sum, item) => sum + item.totalLinesRead, 0);
  const totalUniqueLinesRead = byFile.reduce((sum, item) => sum + item.uniqueLinesRead, 0);
  const totalOverlapLines = byFile.reduce((sum, item) => sum + item.overlapLines, 0);
  const overlapRatePct = totalLinesRead > 0 ? Number(((totalOverlapLines / totalLinesRead) * 100).toFixed(2)) : 0;
  return {
    byFile,
    totalLinesRead,
    totalUniqueLinesRead,
    totalOverlapLines,
    overlapRatePct,
  };
}

function mergeReadOverlapSummaries(summaries: Array<ReadOverlapSummary | null | undefined>): ReadOverlapSummary {
  const byFileAccumulator = new Map<string, { totalLinesRead: number; uniqueLinesRead: number; overlapLines: number }>();
  for (const summary of summaries) {
    if (!summary) {
      continue;
    }
    for (const item of summary.byFile || []) {
      const key = String(item.pathKey || '');
      if (!key) {
        continue;
      }
      const existing = byFileAccumulator.get(key) || { totalLinesRead: 0, uniqueLinesRead: 0, overlapLines: 0 };
      existing.totalLinesRead += Number(item.totalLinesRead || 0);
      existing.uniqueLinesRead += Number(item.uniqueLinesRead || 0);
      existing.overlapLines += Number(item.overlapLines || 0);
      byFileAccumulator.set(key, existing);
    }
  }
  const byFile = Array.from(byFileAccumulator.entries())
    .map(([pathKey, totals]) => ({
      pathKey,
      totalLinesRead: totals.totalLinesRead,
      uniqueLinesRead: totals.uniqueLinesRead,
      overlapLines: totals.overlapLines,
      overlapRatePct: totals.totalLinesRead > 0 ? Number(((totals.overlapLines / totals.totalLinesRead) * 100).toFixed(2)) : 0,
    }))
    .sort((left, right) => left.pathKey.localeCompare(right.pathKey));
  const totalLinesRead = byFile.reduce((sum, item) => sum + item.totalLinesRead, 0);
  const totalUniqueLinesRead = byFile.reduce((sum, item) => sum + item.uniqueLinesRead, 0);
  const totalOverlapLines = byFile.reduce((sum, item) => sum + item.overlapLines, 0);
  const overlapRatePct = totalLinesRead > 0 ? Number(((totalOverlapLines / totalLinesRead) * 100).toFixed(2)) : 0;
  return {
    byFile,
    totalLinesRead,
    totalUniqueLinesRead,
    totalOverlapLines,
    overlapRatePct,
  };
}

function parseGetContentReadWindowCommand(command: string): ParsedGetContentReadWindow | null {
  const trimmed = String(command || '').trim();
  const match = /^get-content\s+(.+?)\s*\|\s*select-object\s+(.+)$/iu.exec(trimmed);
  if (!match) {
    return null;
  }
  const pathExpression = String(match[1] || '').trim();
  const selectExpression = String(match[2] || '').trim();
  if (!pathExpression || !selectExpression) {
    return null;
  }

  const pathTokens = tokenizeShellLike(pathExpression);
  if (!pathTokens.length) {
    return null;
  }
  let pathToken = '';
  if (pathTokens[0].startsWith('-')) {
    pathToken = pathTokens[1] || '';
  } else {
    pathToken = pathTokens[0];
  }
  const pathKey = normalizeReadPathKey(pathToken);
  if (!pathKey) {
    return null;
  }

  const selectTokens = tokenizeShellLike(selectExpression);
  let requestedFirst: number | null = null;
  let requestedSkip = 0;
  let hasExplicitSkip = false;
  for (let index = 0; index < selectTokens.length; index += 1) {
    const token = selectTokens[index].toLowerCase();
    if (token === '-first') {
      requestedFirst = Number(selectTokens[index + 1]);
      index += 1;
      continue;
    }
    if (token === '-skip') {
      requestedSkip = Number(selectTokens[index + 1]);
      hasExplicitSkip = true;
      index += 1;
      continue;
    }
  }
  if (!Number.isFinite(requestedFirst)) {
    return null;
  }
  requestedSkip = Math.max(0, Math.floor(Number(requestedSkip) || 0));
  const first = Math.max(1, Math.floor(Number(requestedFirst) || 0));
  const requestedStart = requestedSkip;
  const requestedEnd = requestedSkip + first;
  return {
    pathKey,
    pathExpression,
    requestedSkip,
    requestedFirst: first,
    requestedStart,
    requestedEnd,
    hasExplicitSkip,
  };
}

function buildGetContentReadWindowCommand(
  pathExpression: string,
  skip: number,
  first: number,
  hasExplicitSkip: boolean,
): string {
  const boundedSkip = Math.max(0, Math.floor(Number(skip) || 0));
  const boundedFirst = Math.max(1, Math.floor(Number(first) || 0));
  if (!hasExplicitSkip && boundedSkip === 0) {
    return `Get-Content ${pathExpression} | Select-Object -First ${boundedFirst}`;
  }
  return `Get-Content ${pathExpression} | Select-Object -Skip ${boundedSkip} -First ${boundedFirst}`;
}

function resolveAvgTokensPerLine(
  currentStats: ToolTypeStats | null | undefined,
  historicalStats: ToolTypeStats | null | undefined,
): number {
  const currentCalls = Number(currentStats?.lineReadCalls || 0);
  const currentLines = Number(currentStats?.lineReadLinesTotal || 0);
  const currentTokens = Number(currentStats?.lineReadTokensTotal || 0);
  if (currentCalls > 0 && currentLines > 0 && currentTokens > 0) {
    const currentAvg = currentTokens / currentLines;
    if (Number.isFinite(currentAvg) && currentAvg > 0) {
      return currentAvg;
    }
  }

  const historicalCalls = Number(historicalStats?.lineReadCalls || 0);
  const historicalLines = Number(historicalStats?.lineReadLinesTotal || 0);
  const historicalTokens = Number(historicalStats?.lineReadTokensTotal || 0);
  if (historicalCalls > 0 && historicalLines > 0 && historicalTokens > 0) {
    const historicalAvg = historicalTokens / historicalLines;
    if (Number.isFinite(historicalAvg) && historicalAvg > 0) {
      return historicalAvg;
    }
  }

  return DEFAULT_LINE_READ_AVG_TOKENS_PER_LINE;
}

// ---------------------------------------------------------------------------
// Task result type
// ---------------------------------------------------------------------------

export type TaskResult = {
  id: string;
  question: string;
  reason: string;
  turnsUsed: number;
  safetyRejects: number;
  invalidResponses: number;
  commandFailures: number;
  commands: TaskCommand[];
  finalOutput: string;
  passed: boolean;
  missingSignals: string[];
  promptTokens: number;
  outputTokens: number;
  toolTokens: number;
  thinkingTokens: number;
  promptCacheTokens: number;
  promptEvalTokens: number;
  toolStats: Record<string, ToolTypeStats>;
  readOverlapSummary: ReadOverlapSummary;
};

// ---------------------------------------------------------------------------
// Main task loop
// ---------------------------------------------------------------------------

type RunTaskLoopOptions = {
  repoRoot: string;
  model: string;
  baseUrl: string;
  config?: SiftConfig;
  totalContextTokens?: number;
  timeoutMs?: number;
  maxTurns?: number;
  maxInvalidResponses?: number;
  minToolCallsBeforeFinish?: number;
  thinkingInterval?: number;
  requestMaxTokens: number;
  plannerToolDefinitions?: ReturnType<typeof resolveRepoSearchPlannerToolDefinitions>;
  enforceThinkingFinish?: boolean;
  includeAgentsMd?: boolean;
  includeRepoFileListing?: boolean;
  mockResponses?: string[];
  mockCommandResults?: Record<string, RepoSearchMockCommandResult>;
  logger?: JsonLogger | null;
  onProgress?: ((event: RepoSearchProgressEvent) => void) | null;
};

export async function runTaskLoop(task: TaskDefinition, options: RunTaskLoopOptions): Promise<TaskResult> {
  const taskStartedAt = Date.now();
  const maxTurns = Math.max(1, Number(options.maxTurns || DEFAULT_MAX_TURNS));
  const maxInvalidResponses = Math.max(1, Number(options.maxInvalidResponses || DEFAULT_MAX_INVALID_RESPONSES));
  const history: HistoryEntry[] = [];
  const commands: TaskCommand[] = [];
  let finalOutput = '';
  let invalidResponses = 0;
  let commandFailures = 0;
  let safetyRejects = 0;
  let reason = 'max_turns';
  let turnsUsed = 0;
  let mockResponseIndex = 0;
  let forceThinkingOnNextTurn = false;
  let modelPromptTokens = 0;
  let modelOutputTokens = 0;
  let modelToolTokens = 0;
  let modelThinkingTokens = 0;
  let modelPromptCacheTokens = 0;
  let modelPromptEvalTokens = 0;
  const toolStatsByType: Record<string, ToolTypeStats> = {};
  const attemptedCommands = new Set<string>();
  const minToolCallsBeforeFinish = Math.max(0, Number(options.minToolCallsBeforeFinish ?? MIN_TOOL_CALLS_BEFORE_FINISH));
  const thinkingInterval = Math.max(1, Math.floor(Number(options.thinkingInterval || 5)));
  const totalContextTokens = Math.max(1, Number(options.totalContextTokens || (options.config ? getConfiguredLlamaNumCtx(options.config) : 32000)));
  const thinkingBufferTokens = Math.max(Math.ceil(totalContextTokens * THINKING_BUFFER_RATIO), THINKING_BUFFER_MIN_TOKENS);
  const usablePromptTokens = Math.max(totalContextTokens - thinkingBufferTokens, 0);
  const useEstimatedTokensOnly = Array.isArray(options.mockResponses);
  const requestMaxTokens = options.requestMaxTokens;
  const followupOnNonThinkingFinish = options.enforceThinkingFinish === true;
  const plannerToolDefinitions = Array.isArray(options.plannerToolDefinitions) && options.plannerToolDefinitions.length > 0
    ? options.plannerToolDefinitions
    : resolveRepoSearchPlannerToolDefinitions();
  const allowedPlannerToolNames = plannerToolDefinitions.map((toolDefinition) => toolDefinition.function.name);
  let zeroOutputStreak = 0;
  let consecutiveDuplicates = 0;
  let consecutiveSemanticRepeats = 0;
  let consecutiveNoNewEvidence = 0;
  let forcedFinishAttemptsRemaining = 0;
  let previousPlannerThinkingEnabled: boolean | null = null;
  let nonThinkingFinishFollowupUsed = false;
  let pendingNonThinkingFinishOutput: string | null = null;
  let lastLoggedMessageCount = 0;
  const slotId = options.config ? allocateLlamaCppSlotId(options.config) : 0;
  const ignorePolicy = buildIgnorePolicy(options.repoRoot);
  const bootstrapFileList = options.includeRepoFileListing === false
    ? undefined
    : (scanRepoFiles(options.repoRoot, ignorePolicy) || undefined);
  const historicalToolStats = readLatestIdleSummaryToolStats();
  const initialPerToolAllowanceTokens = getRepoSearchPromptBaselinePerToolAllowanceTokens(options.config ?? null);
  const attemptedFingerprints = new Set<string>();
  const recentEvidenceKeys = new Set<string>();
  const successfulToolCalls: Array<{ toolName: string; promptResultText: string }> = [];
  let lastReplayFingerprint: string | null = null;
  let replayRepeatCount = 0;
  let lastReplayUserMessageIndex = -1;
  let lastReplayHistoryIndex = -1;
  const fileReadCountByPath = new Map<string, number>();
  const fileReadStateByPath = new Map<string, FileReadState>();

  const messages: ChatMessage[] = [
    {
      role: 'system',
      content: buildTaskSystemPrompt(options.repoRoot, {
        globalToolStats: historicalToolStats,
        initialPerToolAllowanceTokens,
        includeAgentsMd: options.includeAgentsMd,
        includeRepoFileListing: options.includeRepoFileListing,
      }),
    },
    {
      role: 'user',
      content: buildTaskInitialUserPrompt(task.question, bootstrapFileList, {
        includeRepoFileListing: options.includeRepoFileListing,
      }),
    },
  ];

  for (let turn = 1; turn <= maxTurns; turn += 1) {
    turnsUsed = turn;
    const inForcedFinishMode = forcedFinishAttemptsRemaining > 0;
    const plannerThinkingEnabled = inForcedFinishMode
      ? true
      : (forceThinkingOnNextTurn || (((commands.length + 1) % thinkingInterval) === 0));
    if (forceThinkingOnNextTurn && !inForcedFinishMode) {
      forceThinkingOnNextTurn = false;
    }

    let prompt = renderTaskTranscript(messages);
    let preflight = await preflightPlannerPromptBudget({
      config: useEstimatedTokensOnly ? undefined : options.config,
      prompt,
      totalContextTokens,
      thinkingBufferTokens,
      requestMaxTokens,
    });

    options.logger?.write({
      kind: 'turn_preflight_budget', taskId: task.id, turn,
      promptTokenCount: preflight.promptTokenCount, maxPromptBudget: preflight.maxPromptBudget,
      overflowTokens: preflight.overflowTokens, ok: preflight.ok, compacted: false,
    });

    if (!preflight.ok) {
      const compacted = await compactPlannerMessagesOnce({
        messages, config: useEstimatedTokensOnly ? undefined : options.config, maxPromptBudget: preflight.maxPromptBudget,
      });
      messages.splice(0, messages.length, ...compacted.messages);
      lastLoggedMessageCount = 0;
      prompt = renderTaskTranscript(messages);
      const afterCompaction = await preflightPlannerPromptBudget({
        config: useEstimatedTokensOnly ? undefined : options.config, prompt, totalContextTokens, thinkingBufferTokens, requestMaxTokens,
      });
      options.logger?.write({
        kind: 'turn_preflight_compaction_applied', taskId: task.id, turn,
        beforePromptTokenCount: preflight.promptTokenCount,
        afterPromptTokenCount: afterCompaction.promptTokenCount,
        maxPromptBudget: afterCompaction.maxPromptBudget,
        droppedMessageCount: compacted.droppedMessageCount,
        summaryInserted: compacted.summaryInserted,
      });
      preflight = afterCompaction;
    }

    if (!preflight.ok) {
      const overflowError = new Error(
        `planner_preflight_overflow prompt_tokens=${preflight.promptTokenCount} `
        + `max_prompt_tokens=${preflight.maxPromptBudget} overflow_tokens=${preflight.overflowTokens} `
        + `request_max_tokens=${requestMaxTokens} total_context_tokens=${totalContextTokens} `
        + `thinking_buffer_tokens=${thinkingBufferTokens}`,
      );
      options.logger?.write({
        kind: 'turn_preflight_overflow_fail', taskId: task.id, turn,
        promptTokenCount: preflight.promptTokenCount, maxPromptBudget: preflight.maxPromptBudget,
        overflowTokens: preflight.overflowTokens, requestMaxTokens, totalContextTokens, thinkingBufferTokens,
        error: overflowError.message,
      });
      throw overflowError;
    }

    options.logger?.write({ kind: 'turn_model_request', taskId: task.id, turn, thinkingEnabled: plannerThinkingEnabled });
    if (options.onProgress) {
      options.onProgress({ kind: 'llm_start', turn, maxTurns, promptTokenCount: preflight.promptTokenCount, elapsedMs: Date.now() - taskStartedAt });
    }
    const newMessages = messages.slice(lastLoggedMessageCount);
    lastLoggedMessageCount = messages.length;
    options.logger?.write({ kind: 'turn_new_messages', taskId: task.id, turn, messages: newMessages, promptTokenCount: preflight.promptTokenCount });

    const response: PlannerActionResponse = await requestPlannerAction({
      baseUrl: options.baseUrl,
      model: options.model,
      messages,
      slotId,
      timeoutMs: options.timeoutMs || DEFAULT_TIMEOUT_MS,
      requestMaxTokens,
      thinkingEnabled: plannerThinkingEnabled,
      stream: Boolean(options.onProgress),
      onThinkingDelta: options.onProgress
        ? (accThinking) => { options.onProgress!({ kind: 'thinking', turn, maxTurns, thinkingText: accThinking }); }
        : undefined,
      onContentDelta: options.onProgress
        ? (accContent) => { options.onProgress!({ kind: 'thinking', turn, maxTurns, thinkingText: accContent }); }
        : undefined,
      mockResponses: options.mockResponses,
      mockResponseIndex,
      logger: options.logger || null,
      toolDefinitions: plannerToolDefinitions,
    });

    if (options.onProgress) {
      options.onProgress({ kind: 'llm_end', turn, maxTurns, promptTokenCount: preflight.promptTokenCount, elapsedMs: Date.now() - taskStartedAt });
    }
    previousPlannerThinkingEnabled = plannerThinkingEnabled;
    if (typeof response.nextMockResponseIndex === 'number') {
      mockResponseIndex = response.nextMockResponseIndex;
    }

    options.logger?.write({
      kind: 'turn_model_response', taskId: task.id, turn,
      text: response.text, thinkingText: response.thinkingText || '',
      mockExhausted: Boolean(response.mockExhausted),
      promptTokens: Number.isFinite(response.promptTokens) ? Number(response.promptTokens) : null,
      completionTokens: Number.isFinite(response.completionTokens) ? Number(response.completionTokens) : null,
      usageThinkingTokens: Number.isFinite(response.usageThinkingTokens) ? Number(response.usageThinkingTokens) : null,
      promptCacheTokens: Number.isFinite(response.promptCacheTokens) ? Number(response.promptCacheTokens) : null,
      promptEvalTokens: Number.isFinite(response.promptEvalTokens) ? Number(response.promptEvalTokens) : null,
    });

    if (Number.isFinite(response.promptTokens) && Number(response.promptTokens) >= 0) modelPromptTokens += Number(response.promptTokens);
    const resolvedCompletionTokens = Number.isFinite(response.completionTokens) && Number(response.completionTokens) >= 0
      ? Number(response.completionTokens)
      : (String(response.text || '').trim() ? estimateTokenCount(options.config, String(response.text || '')) : 0);
    const resolvedThinkingTokens = Number.isFinite(response.usageThinkingTokens) && Number(response.usageThinkingTokens) >= 0
      ? Number(response.usageThinkingTokens)
      : (String(response.thinkingText || '').trim() ? estimateTokenCount(options.config, String(response.thinkingText || '')) : 0);
    modelThinkingTokens += resolvedThinkingTokens;
    if (Number.isFinite(response.promptCacheTokens) && Number(response.promptCacheTokens) >= 0) modelPromptCacheTokens += Number(response.promptCacheTokens);
    if (Number.isFinite(response.promptEvalTokens) && Number(response.promptEvalTokens) >= 0) modelPromptEvalTokens += Number(response.promptEvalTokens);

    if (response.mockExhausted) { reason = 'mock_responses_exhausted'; break; }
    const responseText = String(response.text || '').trim();
    if (pendingNonThinkingFinishOutput && isFollowupConfirmationResponse(responseText)) {
      modelOutputTokens += resolvedCompletionTokens;
      finalOutput = pendingNonThinkingFinishOutput;
      pendingNonThinkingFinishOutput = null;
      options.logger?.write({ kind: 'turn_followup_confirmation_accepted', taskId: task.id, turn, responseText });
      if (options.onProgress) {
        options.onProgress({ kind: 'thinking', turn, maxTurns, thinkingText: finalOutput });
      }
      reason = 'finish';
      break;
    }

    let action;
    try {
      action = parsePlannerAction(response.text, { allowedToolNames: allowedPlannerToolNames });
      options.logger?.write({ kind: 'turn_action_parsed', taskId: task.id, turn, action });
    } catch (error) {
      modelOutputTokens += resolvedCompletionTokens;
      invalidResponses += 1;
      if (String(response.text || '').trim()) {
        messages.push({ role: 'assistant', content: String(response.text).trim() });
      }
      messages.push({ role: 'user', content: `Invalid action: ${error instanceof Error ? error.message : String(error)}. Return a valid JSON finish action or tool action payload.` });
      options.logger?.write({ kind: 'turn_action_invalid', taskId: task.id, turn, invalidResponses, error: error instanceof Error ? error.message : String(error) });
      if (invalidResponses >= maxInvalidResponses) { reason = 'invalid_response_limit'; break; }
      history.push({ command: '[invalid action]', resultText: `Invalid action: ${error instanceof Error ? error.message : String(error)}` });
      continue;
    }

    // Emit native thinking text (from reasoning_content) to UI
    if (response.thinkingText && options.onProgress) {
      options.onProgress({ kind: 'thinking', turn, maxTurns, thinkingText: response.thinkingText });
    }

    if (action.action === 'finish') {
      modelOutputTokens += resolvedCompletionTokens;
      const finishEvaluation = evaluateFinishAttempt({
        loopKind: 'repo-search',
        finalOutput: action.output,
        successfulToolCalls,
      });
      if (!finishEvaluation.allowed) {
        const warning = finishEvaluation.warning || 'Need stronger repository evidence before finishing.';
        const loopStats = toolStatsByType.loop || createEmptyToolTypeStats();
        toolStatsByType.loop = {
          ...loopStats,
          finishRejections: loopStats.finishRejections + 1,
        };
        messages.push({ role: 'assistant', content: response.text });
        messages.push({ role: 'user', content: warning });
        history.push({ command: '[finish rejected]', resultText: warning });
        options.logger?.write({ kind: 'turn_finish_rejected', taskId: task.id, turn, toolCallTurns: commands.length, minToolCallsBeforeFinish, warning });
        continue;
      }
      if (followupOnNonThinkingFinish && !plannerThinkingEnabled && !nonThinkingFinishFollowupUsed) {
        if (commands.length >= NON_THINKING_FINISH_AUTO_ACCEPT_TOOL_CALL_THRESHOLD) {
          options.logger?.write({
            kind: 'turn_non_thinking_finish_auto_accepted',
            taskId: task.id,
            turn,
            toolCallTurns: commands.length,
            threshold: NON_THINKING_FINISH_AUTO_ACCEPT_TOOL_CALL_THRESHOLD,
          });
          finalOutput = action.output;
          if (options.onProgress) {
            options.onProgress({ kind: 'thinking', turn, maxTurns, thinkingText: finalOutput });
          }
          reason = 'finish';
          break;
        }
        nonThinkingFinishFollowupUsed = true;
        pendingNonThinkingFinishOutput = action.output;
        messages.push({ role: 'assistant', content: response.text });
        messages.push({ role: 'user', content: NON_THINKING_FINISH_FOLLOWUP_PROMPT });
        history.push({ command: '[follow-up]', resultText: NON_THINKING_FINISH_FOLLOWUP_PROMPT });
        forceThinkingOnNextTurn = true;
        options.logger?.write({ kind: 'turn_non_thinking_finish_followup', taskId: task.id, turn, followupPrompt: NON_THINKING_FINISH_FOLLOWUP_PROMPT, forcedThinkingOnNextTurn: true });
        continue;
      }
      options.logger?.write({ kind: 'turn_finish_validation_skipped', taskId: task.id, turn, reason: 'planner_already_thinking' });
      finalOutput = pendingNonThinkingFinishOutput ?? action.output;
      pendingNonThinkingFinishOutput = null;
      if (options.onProgress) {
        options.onProgress({ kind: 'thinking', turn, maxTurns, thinkingText: finalOutput });
      }
      reason = 'finish';
      break;
    }

    // Tool action
    const toolActions = action.action === 'tool_batch'
      ? action.tool_calls.map((toolCall) => ({
        action: 'tool' as const,
        tool_name: toolCall.tool_name,
        args: toolCall.args,
      }))
      : [action];
    modelToolTokens += resolvedCompletionTokens;
    pendingNonThinkingFinishOutput = null;

    for (const toolAction of toolActions) {
      const normalizedToolName = String(toolAction.tool_name || '').trim().toLowerCase();
      if (!isRepoSearchCommandToolName(normalizedToolName)) {
        invalidResponses += 1;
        const unsupportedToolMessage = `Invalid action: unsupported planner tool "${toolAction.tool_name}" for repo-search. Use one of: ${allowedPlannerToolNames.join(', ')}.`;
        messages.push({ role: 'assistant', content: JSON.stringify(toolAction) });
        messages.push({ role: 'user', content: unsupportedToolMessage });
        options.logger?.write({ kind: 'turn_action_invalid', taskId: task.id, turn, invalidResponses, error: unsupportedToolMessage });
        if (invalidResponses >= maxInvalidResponses) { reason = 'invalid_response_limit'; break; }
        history.push({ command: '[invalid action]', resultText: unsupportedToolMessage });
        continue;
      }
      const command = typeof toolAction.args.command === 'string' ? toolAction.args.command : '';
      if (!command.trim()) {
        invalidResponses += 1;
        const invalidCommandMessage = `Invalid action: ${normalizedToolName} requires args.command.`;
        messages.push({ role: 'assistant', content: JSON.stringify(toolAction) });
        messages.push({ role: 'user', content: invalidCommandMessage });
        options.logger?.write({ kind: 'turn_action_invalid', taskId: task.id, turn, invalidResponses, error: invalidCommandMessage });
        if (invalidResponses >= maxInvalidResponses) { reason = 'invalid_response_limit'; break; }
        history.push({ command: '[invalid action]', resultText: invalidCommandMessage });
        continue;
      }
      const expectedCommandToken = getRepoSearchCommandTokenForToolName(normalizedToolName);
      const actualCommandToken = getFirstCommandToken(command);
      if (!expectedCommandToken || actualCommandToken !== expectedCommandToken) {
        invalidResponses += 1;
        const invalidToolCommandMessage = `Invalid action: ${normalizedToolName} only allows commands starting with '${expectedCommandToken || '<unknown>'}'.`;
        messages.push({ role: 'assistant', content: JSON.stringify(toolAction) });
        messages.push({ role: 'user', content: invalidToolCommandMessage });
        options.logger?.write({ kind: 'turn_action_invalid', taskId: task.id, turn, invalidResponses, error: invalidToolCommandMessage });
        if (invalidResponses >= maxInvalidResponses) { reason = 'invalid_response_limit'; break; }
        history.push({ command: '[invalid action]', resultText: invalidToolCommandMessage });
        continue;
      }
      const assistantActionText = JSON.stringify(toolAction);

    if (inForcedFinishMode) {
      forcedFinishAttemptsRemaining = Math.max(forcedFinishAttemptsRemaining - 1, 0);
      const forcedReason = `Forced finish mode active. Return a finish action now. Attempts remaining: ${forcedFinishAttemptsRemaining}.`;
      commandFailures += 1;
      commands.push({ command, safe: false, reason: forcedReason, exitCode: null, output: `Rejected command: ${forcedReason}` });
      messages.push({ role: 'assistant', content: assistantActionText });
      messages.push({ role: 'user', content: `Rejected command: ${forcedReason}` });
      history.push({ command, resultText: `Rejected command: ${forcedReason}` });
      if (forcedFinishAttemptsRemaining === 0) { reason = 'forced_finish_attempt_limit'; break; }
      continue;
    }

    const normalized = normalizePlannerCommand(command, { repoRoot: options.repoRoot, ignorePolicy });
    const fingerprint = normalized.rejected
      ? ''
      : fingerprintToolCall({ toolName: normalizedToolName, command: normalized.command });
    const prospectiveToolType = normalized.rejected
      ? 'loop'
      : normalizeToolTypeFromCommand(normalized.command);

    // Duplicate check on the normalized command so auto-appended flags don't confuse dedup
    const normalizedKey = normalized.rejected ? command : normalized.command;
    if (attemptedCommands.has(normalizedKey)) {
      consecutiveDuplicates += 1;
      commandFailures += 1;
      const duplicateMessage = `That command was already run ${consecutiveDuplicates} time(s). You MUST use different keywords, a narrower path, or try reading a file directly. If you have enough evidence, use {"action":"finish",...}.`;
      commands.push({ command, safe: false, reason: 'duplicate command', exitCode: null, output: `Rejected: ${duplicateMessage}` });
      messages.push({ role: 'assistant', content: assistantActionText });
      messages.push({ role: 'user', content: duplicateMessage });
      history.push({ command, resultText: `Rejected: ${duplicateMessage}` });
      if (consecutiveDuplicates >= 5 && forcedFinishAttemptsRemaining === 0) {
        forcedFinishAttemptsRemaining = FORCED_FINISH_MAX_ATTEMPTS;
        messages.push({ role: 'user', content: 'Forced finish mode active. Return {"action":"finish",...} now. Tool calls are blocked.' });
        options.logger?.write({ kind: 'turn_forced_finish_mode_started', taskId: task.id, turn, attemptsRemaining: forcedFinishAttemptsRemaining, trigger: 'consecutive_duplicates' });
      }
      continue;
    }
    if (!normalized.rejected && fingerprint && attemptedFingerprints.has(fingerprint)) {
      consecutiveSemanticRepeats += 1;
      commandFailures += 1;
      const semanticMessage = 'That command repeats the same search intent and is unlikely to add new evidence. Change the keywords, path, or tool. If the current evidence is enough, finish now.';
      const currentToolStats = toolStatsByType[prospectiveToolType] || createEmptyToolTypeStats();
      toolStatsByType[prospectiveToolType] = {
        ...currentToolStats,
        semanticRepeatRejects: currentToolStats.semanticRepeatRejects + 1,
      };
      commands.push({ command, safe: false, reason: 'semantic duplicate command', exitCode: null, output: `Rejected: ${semanticMessage}` });
      messages.push({ role: 'assistant', content: assistantActionText });
      messages.push({ role: 'user', content: semanticMessage });
      history.push({ command, resultText: `Rejected: ${semanticMessage}` });
      options.logger?.write({
        kind: 'turn_semantic_repeat_rejected',
        taskId: task.id,
        turn,
        command,
        fingerprint,
        repeats: consecutiveSemanticRepeats,
      });
      if (consecutiveSemanticRepeats >= 2 && forcedFinishAttemptsRemaining === 0) {
        forcedFinishAttemptsRemaining = FORCED_FINISH_MAX_ATTEMPTS;
        const forcedMessage = 'Forced finish mode active. Current evidence is already repeating. Return {"action":"finish",...} now. Tool calls are blocked.';
        messages.push({ role: 'user', content: forcedMessage });
        toolStatsByType[prospectiveToolType] = {
          ...toolStatsByType[prospectiveToolType],
          forcedFinishFromStagnation: Number(toolStatsByType[prospectiveToolType]?.forcedFinishFromStagnation || 0) + 1,
        };
        options.logger?.write({ kind: 'turn_forced_finish_mode_started', taskId: task.id, turn, attemptsRemaining: forcedFinishAttemptsRemaining, trigger: 'semantic_repetition' });
      }
      continue;
    }
    attemptedCommands.add(normalizedKey);
    if (fingerprint) {
      attemptedFingerprints.add(fingerprint);
    }
    consecutiveDuplicates = 0;
    consecutiveSemanticRepeats = 0;
    if (normalized.rejected) {
      safetyRejects += 1;
      const rejection = `Rejected command: ${normalized.rejectedReason}`;
      commands.push({ command, safe: false, reason: normalized.rejectedReason || null, exitCode: null, output: rejection });
      messages.push({ role: 'assistant', content: assistantActionText });
      messages.push({ role: 'user', content: rejection });
      history.push({ command, resultText: rejection });
      continue;
    }

    const requestedCommand = command;
    const normalizedCommand = normalized.command;
    const preExecutionDynamicPerToolRatio = Math.max(PER_TOOL_RESULT_RATIO, Number(commands.length) / Number(maxTurns));
    const preExecutionPerToolCapTokens = Math.max(1, Math.floor(usablePromptTokens * preExecutionDynamicPerToolRatio));
    const parsedReadWindow = parseGetContentReadWindowCommand(normalizedCommand);
    let commandToRun = normalizedCommand;
    let lineReadAdjustment: LineReadAdjustment | null = null;

    if (parsedReadWindow) {
      const previousReadCount = Number(fileReadCountByPath.get(parsedReadWindow.pathKey) || 0);
      if (previousReadCount >= 1) {
        const minTokensFromCap = Math.max(1, Math.ceil(preExecutionPerToolCapTokens * REPEATED_LINE_READ_MIN_RATIO));
        const currentGetContentStats = toolStatsByType['get-content'] || null;
        const historicalGetContentStats = historicalToolStats['get-content'] || null;
        const avgTokensPerLine = resolveAvgTokensPerLine(currentGetContentStats, historicalGetContentStats);
        const minLinesFromCap = Math.max(1, Math.ceil(minTokensFromCap / avgTokensPerLine));
        const existingReadState = getOrCreateFileReadState(fileReadStateByPath, parsedReadWindow.pathKey);
        const previousExecutedMaxEnd = getPreviousExecutedMaxEnd(existingReadState);
        const adjustedWindow = computeAdjustedReadWindow({
          requestedStart: parsedReadWindow.requestedStart,
          requestedEnd: parsedReadWindow.requestedEnd,
          minLinesFromCap,
          roundingStep: LINE_READ_ROUNDING_STEP,
          previousExecutedMaxEnd,
        });
        if (adjustedWindow.adjusted) {
          const adjustedFirst = Math.max(1, adjustedWindow.end - adjustedWindow.start);
          commandToRun = buildGetContentReadWindowCommand(
            parsedReadWindow.pathExpression,
            adjustedWindow.start,
            adjustedFirst,
            parsedReadWindow.hasExplicitSkip,
          );
          lineReadAdjustment = {
            executedCommand: commandToRun,
            requestedStart: parsedReadWindow.requestedStart,
            requestedEnd: parsedReadWindow.requestedEnd,
            adjustedStart: adjustedWindow.start,
            adjustedEnd: adjustedWindow.end,
            minLinesFromCap,
            perToolCapTokens: preExecutionPerToolCapTokens,
            reason: adjustedWindow.reason,
          };
        }
      }
    }

    const safety = evaluateCommandSafety(commandToRun, options.repoRoot);
    options.logger?.write({ kind: 'turn_command_safety', taskId: task.id, turn, command: commandToRun, safe: safety.safe, reason: safety.reason });

    if (!safety.safe) {
      safetyRejects += 1;
      const rejection = `Rejected command: ${safety.reason}`;
      commands.push({ command: commandToRun, safe: false, reason: safety.reason, exitCode: null, output: rejection });
      messages.push({ role: 'assistant', content: assistantActionText });
      messages.push({ role: 'user', content: rejection });
      history.push({ command: commandToRun, resultText: rejection });
      continue;
    }

    const promptTokenCount = useEstimatedTokensOnly
      ? estimateTokenCount(options.config, prompt)
      : await countTokensWithFallback(options.config, prompt);

    if (options.onProgress) {
      options.onProgress({ kind: 'tool_start', turn, maxTurns, command: commandToRun, promptTokenCount, elapsedMs: Date.now() - taskStartedAt });
    }

    const executed = await executeRepoCommand(commandToRun, options.repoRoot, options.mockCommandResults || null);
    const baseOutput = String(executed.output || '').trim();
    const executedReadWindow = parseGetContentReadWindowCommand(commandToRun);
    let lineReadOverlapLines = 0;
    let lineReadNewLinesCovered = 0;
    let lineReadCumulativeUniqueLines = 0;
    if (parsedReadWindow) {
      fileReadCountByPath.set(parsedReadWindow.pathKey, Number(fileReadCountByPath.get(parsedReadWindow.pathKey) || 0) + 1);
    }
    if (parsedReadWindow && executedReadWindow && executedReadWindow.pathKey === parsedReadWindow.pathKey) {
      const fileReadState = getOrCreateFileReadState(fileReadStateByPath, parsedReadWindow.pathKey);
      const executedRange: ReadRange = {
        start: executedReadWindow.requestedStart,
        end: executedReadWindow.requestedEnd,
      };
      const linesRead = Math.max(0, executedRange.end - executedRange.start);
      lineReadOverlapLines = overlapWithRanges(fileReadState.mergedExecutedRanges, executedRange);
      lineReadNewLinesCovered = Math.max(0, linesRead - lineReadOverlapLines);
      fileReadState.totalLinesRead += linesRead;
      fileReadState.overlapLines += lineReadOverlapLines;
      fileReadState.uniqueLinesRead += lineReadNewLinesCovered;
      fileReadState.mergedExecutedRanges = mergeRange(fileReadState.mergedExecutedRanges, executedRange);
      fileReadState.windows.push({
        turn,
        requestedStart: parsedReadWindow.requestedStart,
        requestedEnd: parsedReadWindow.requestedEnd,
        executedStart: executedRange.start,
        executedEnd: executedRange.end,
        adjusted: Boolean(lineReadAdjustment),
      });
      lineReadCumulativeUniqueLines = fileReadState.uniqueLinesRead;
    }

    if (options.onProgress) {
      const snippet = baseOutput.length > 200 ? baseOutput.slice(0, 200) + '...' : baseOutput;
      options.onProgress({ kind: 'tool_result', turn, maxTurns, command: commandToRun, exitCode: executed.exitCode, outputSnippet: snippet, promptTokenCount, elapsedMs: Date.now() - taskStartedAt });
    }

    const rewriteNotesForLogs: string[] = [];
    const rewriteNotesForPrompt: string[] = [];
    if (normalized.rewritten && normalized.note) {
      rewriteNotesForLogs.push(normalized.note);
      rewriteNotesForPrompt.push(normalized.note);
    }
    if (lineReadAdjustment) {
      rewriteNotesForLogs.push(
        `note: repeated file read window adjusted; requested start=${lineReadAdjustment.requestedStart} end=${lineReadAdjustment.requestedEnd}; adjusted start=${lineReadAdjustment.adjustedStart} end=${lineReadAdjustment.adjustedEnd}; reason=${lineReadAdjustment.reason}; ran '${lineReadAdjustment.executedCommand}' instead`
      );
    }
    const outputWithRewriteNote = rewriteNotesForLogs.length > 0
      ? `${rewriteNotesForLogs.join('\n')}\n${baseOutput}`.trim()
      : baseOutput;
    const outputForPrompt = rewriteNotesForPrompt.length > 0
      ? `${rewriteNotesForPrompt.join('\n')}\n${baseOutput}`.trim()
      : baseOutput;

    if (Number(executed.exitCode) !== 0 && !isSearchNoMatchExit(commandToRun, executed.exitCode)) {
      commandFailures += 1;
    }

    if (baseOutput.length === 0) {
      zeroOutputStreak += 1;
      const remainingBeforeForce = Math.max(ZERO_OUTPUT_FORCE_THRESHOLD - zeroOutputStreak, 0);
      history.push({
        command: '[zero-output-warning]',
        resultText: remainingBeforeForce > 0
          ? `Zero-output warning: ${remainingBeforeForce} more zero-output command(s) and you will be forced to answer.`
          : `Zero-output limit reached: you are now forced to answer within ${FORCED_FINISH_MAX_ATTEMPTS} attempt(s).`,
      });
      options.logger?.write({
        kind: 'turn_zero_output_countdown', taskId: task.id, turn, zeroOutputStreak, remainingBeforeForce,
      });
      if (remainingBeforeForce === 0 && forcedFinishAttemptsRemaining === 0) {
        forcedFinishAttemptsRemaining = FORCED_FINISH_MAX_ATTEMPTS;
        messages.push({ role: 'user', content: 'Forced finish mode active. Return {"action":"finish",...} now. Tool calls are blocked.' });
        options.logger?.write({
          kind: 'turn_forced_finish_mode_started', taskId: task.id, turn, attemptsRemaining: forcedFinishAttemptsRemaining,
        });
      }
    } else {
      zeroOutputStreak = 0;
    }

    // For search commands (rg/grep), exit_code=1 means "no match" — but when there IS output it
    // means the pipeline was terminated early (e.g. `| Select-Object -First N` closed the pipe
    // before rg finished, causing a broken-pipe exit). In that case the output is valid truncated
    // results, not an error, so don't prepend a misleading `exit_code=1` prefix.
    const suppressExitCode = isSearchNoMatchExit(commandToRun, executed.exitCode) && outputForPrompt.length > 0;
    const rawResultText = suppressExitCode
      ? outputForPrompt
      : `exit_code=${executed.exitCode}\n${outputForPrompt}`.trim();
    let resultText = buildPromptToolResult({
      toolName: normalizedToolName,
      command: commandToRun,
      exitCode: executed.exitCode,
      rawOutput: rawResultText,
    });
    const rawResultTokenCount = useEstimatedTokensOnly
      ? estimateTokenCount(options.config, rawResultText)
      : await countTokensWithFallback(options.config, rawResultText);
    const lineReadStats = getRepoSearchLineReadStats(commandToRun, baseOutput, rawResultTokenCount);
    const dynamicPerToolRatio = Math.max(PER_TOOL_RESULT_RATIO, Number(commands.length) / Number(maxTurns));
    const perToolCapTokens = Math.max(1, Math.floor(usablePromptTokens * dynamicPerToolRatio));
    const remainingTokenAllowance = Math.max(usablePromptTokens - promptTokenCount, 0);
    const candidateResultTokenCount = useEstimatedTokensOnly
      ? estimateTokenCount(options.config, resultText)
      : await countTokensWithFallback(options.config, resultText);

    if (rawResultTokenCount > perToolCapTokens || rawResultTokenCount > remainingTokenAllowance) {
      resultText = `Error: requested output would consume ${rawResultTokenCount} tokens, remaining token allowance: ${remainingTokenAllowance}, per tool call allowance: ${perToolCapTokens}`;
      writeRedConsoleLine(`repo_search warning: ${resultText}`);
    }
    let resultTokenCount = 0;
    let resultTokenCountEstimated = false;
    if (useEstimatedTokensOnly) {
      resultTokenCount = estimateTokenCount(options.config, resultText);
      resultTokenCountEstimated = true;
    } else {
      const exactResultTokenCount = options.config
        ? await countLlamaCppTokens(options.config, resultText)
        : null;
      if (Number.isFinite(exactResultTokenCount) && Number(exactResultTokenCount) > 0) {
        resultTokenCount = Number(exactResultTokenCount);
      } else {
        resultTokenCount = estimateTokenCount(options.config, resultText);
        resultTokenCountEstimated = true;
      }
    }
    const toolType = normalizeToolTypeFromCommand(commandToRun);
    const currentToolStats = toolStatsByType[toolType] || createEmptyToolTypeStats();
    toolStatsByType[toolType] = {
      ...currentToolStats,
      calls: currentToolStats.calls + 1,
      outputCharsTotal: currentToolStats.outputCharsTotal + resultText.length,
      outputTokensTotal: currentToolStats.outputTokensTotal + Math.max(0, Math.ceil(resultTokenCount)),
      outputTokensEstimatedCount: currentToolStats.outputTokensEstimatedCount + (resultTokenCountEstimated ? 1 : 0),
      lineReadCalls: currentToolStats.lineReadCalls + Number(lineReadStats?.lineReadCalls || 0),
      lineReadLinesTotal: currentToolStats.lineReadLinesTotal + Number(lineReadStats?.lineReadLinesTotal || 0),
      lineReadTokensTotal: currentToolStats.lineReadTokensTotal + Number(lineReadStats?.lineReadTokensTotal || 0),
      promptInsertedTokens: currentToolStats.promptInsertedTokens + Math.max(0, Math.ceil(resultTokenCount)),
      rawToolResultTokens: currentToolStats.rawToolResultTokens + Math.max(0, Math.ceil(rawResultTokenCount)),
    };
    const novelty = baseOutput.length === 0
      ? { evidenceKeys: [], hasNewEvidence: true }
      : classifyToolResultNovelty({
        promptResultText: resultText,
        recentEvidenceKeys,
      });
    toolStatsByType[toolType] = {
      ...toolStatsByType[toolType],
      newEvidenceCalls: toolStatsByType[toolType].newEvidenceCalls + (novelty.hasNewEvidence ? 1 : 0),
      noNewEvidenceCalls: toolStatsByType[toolType].noNewEvidenceCalls + (novelty.hasNewEvidence ? 0 : 1),
    };
    for (const evidenceKey of novelty.evidenceKeys) {
      recentEvidenceKeys.add(evidenceKey);
    }
    if (novelty.evidenceKeys.length > 0) {
      successfulToolCalls.push({ toolName: toolType, promptResultText: resultText });
    }

    options.logger?.write({
      kind: 'turn_command_result', taskId: task.id, turn, command: commandToRun,
      requestedCommand,
      executedCommand: commandToRun,
      lineReadAdjusted: Boolean(lineReadAdjustment),
      lineReadRequestedStart: parsedReadWindow?.requestedStart,
      lineReadRequestedEnd: parsedReadWindow?.requestedEnd,
      lineReadAdjustedStart: lineReadAdjustment?.adjustedStart,
      lineReadAdjustedEnd: lineReadAdjustment?.adjustedEnd,
      lineReadMinLinesFromCap: lineReadAdjustment?.minLinesFromCap,
      lineReadPerToolCapTokens: lineReadAdjustment?.perToolCapTokens,
      lineReadExecutedStart: executedReadWindow?.requestedStart,
      lineReadExecutedEnd: executedReadWindow?.requestedEnd,
      lineReadOverlapLines: executedReadWindow ? lineReadOverlapLines : undefined,
      lineReadNewLinesCovered: executedReadWindow ? lineReadNewLinesCovered : undefined,
      lineReadCumulativeUniqueLines: executedReadWindow ? lineReadCumulativeUniqueLines : undefined,
      exitCode: executed.exitCode, output: outputWithRewriteNote,
      promptTokenCount, resultTokenCount, perToolCapTokens, remainingTokenAllowance,
      insertedResultText: resultText,
    });

    commands.push({ command: commandToRun, safe: true, reason: null, exitCode: executed.exitCode, output: outputWithRewriteNote });
    const replayAssistantText = lineReadAdjustment
      ? JSON.stringify({ action: 'tool', tool_name: normalizedToolName, args: { command: commandToRun } })
      : assistantActionText;
    let appendReplayMessages = true;
    if (novelty.hasNewEvidence) {
      consecutiveNoNewEvidence = 0;
      const replayFingerprint = buildToolReplayFingerprint({
        toolName: toolType,
        promptResultText: resultText,
      });
      lastReplayFingerprint = replayFingerprint;
      replayRepeatCount = 1;
      lastReplayUserMessageIndex = messages.length + 1;
      lastReplayHistoryIndex = history.length;
    } else {
      consecutiveNoNewEvidence += 1;
      const replayFingerprint = buildToolReplayFingerprint({
        toolName: toolType,
        promptResultText: resultText,
      });
      if (lastReplayFingerprint === replayFingerprint) {
        replayRepeatCount += 1;
        const summary = buildRepeatedToolCallSummary(commandToRun, replayRepeatCount);
        if (lastReplayUserMessageIndex >= 0 && lastReplayUserMessageIndex < messages.length) {
          messages[lastReplayUserMessageIndex] = { role: 'user', content: summary };
          appendReplayMessages = false;
        }
        if (lastReplayHistoryIndex >= 0 && lastReplayHistoryIndex < history.length) {
          history[lastReplayHistoryIndex] = { command: '[repeated tool call]', resultText: summary };
        }
      } else {
        lastReplayFingerprint = replayFingerprint;
        replayRepeatCount = 1;
        lastReplayUserMessageIndex = messages.length + 1;
        lastReplayHistoryIndex = history.length;
      }

      if (replayRepeatCount === STAGNATION_WARNING_THRESHOLD) {
        const stagnationMessage = 'Repeated tool output x3. Use a different command now or you will be forced to answer.';
        messages.push({ role: 'user', content: stagnationMessage });
        history.push({ command: '[stagnation warning]', resultText: stagnationMessage });
        toolStatsByType[toolType] = {
          ...toolStatsByType[toolType],
          stagnationWarnings: toolStatsByType[toolType].stagnationWarnings + 1,
        };
        options.logger?.write({ kind: 'turn_stagnation_warning', taskId: task.id, turn, toolType, consecutiveNoNewEvidence });
      }
      if (replayRepeatCount >= STAGNATION_FORCE_THRESHOLD && forcedFinishAttemptsRemaining === 0) {
        forcedFinishAttemptsRemaining = FORCED_FINISH_MAX_ATTEMPTS;
        messages.push({ role: 'user', content: 'Forced finish mode active. You repeated the same tool output too many times. Return {"action":"finish",...} now. Tool calls are blocked.' });
        toolStatsByType[toolType] = {
          ...toolStatsByType[toolType],
          forcedFinishFromStagnation: toolStatsByType[toolType].forcedFinishFromStagnation + 1,
        };
        options.logger?.write({ kind: 'turn_forced_finish_mode_started', taskId: task.id, turn, attemptsRemaining: forcedFinishAttemptsRemaining, trigger: 'no_new_evidence' });
      }
    }

    if (appendReplayMessages) {
      messages.push({ role: 'assistant', content: replayAssistantText });
      messages.push({ role: 'user', content: resultText });
      history.push({ command: commandToRun, resultText });
    }
    }
    if (reason === 'forced_finish_attempt_limit') {
      break;
    }
  }

  // Terminal synthesis if no final output
  if (!String(finalOutput || '').trim()) {
    let usedFallback = false;
    const synthesisPrompt = buildTerminalSynthesisPrompt({ question: task.question, reason, history });
    options.logger?.write({ kind: 'task_terminal_synthesis_requested', taskId: task.id, reason });

    try {
      const synthesisResponse = await requestTerminalSynthesis({
        baseUrl: options.baseUrl,
        model: options.model,
        prompt: synthesisPrompt,
        timeoutMs: options.timeoutMs || DEFAULT_TIMEOUT_MS,
        mockResponses: options.mockResponses,
        mockResponseIndex,
        requestMaxTokens,
        logger: options.logger || null,
      });
      if (typeof synthesisResponse.nextMockResponseIndex === 'number') {
        mockResponseIndex = synthesisResponse.nextMockResponseIndex;
      }
      if (Number.isFinite(synthesisResponse.promptTokens) && Number(synthesisResponse.promptTokens) >= 0) modelPromptTokens += Number(synthesisResponse.promptTokens);
      const resolvedSynthesisCompletionTokens = Number.isFinite(synthesisResponse.completionTokens) && Number(synthesisResponse.completionTokens) >= 0
        ? Number(synthesisResponse.completionTokens)
        : (String(synthesisResponse.text || '').trim() ? estimateTokenCount(options.config, String(synthesisResponse.text || '')) : 0);
      const resolvedSynthesisThinkingTokens = Number.isFinite(synthesisResponse.usageThinkingTokens) && Number(synthesisResponse.usageThinkingTokens) >= 0
        ? Number(synthesisResponse.usageThinkingTokens)
        : (String(synthesisResponse.thinkingText || '').trim() ? estimateTokenCount(options.config, String(synthesisResponse.thinkingText || '')) : 0);
      modelOutputTokens += resolvedSynthesisCompletionTokens;
      modelThinkingTokens += resolvedSynthesisThinkingTokens;
      if (Number.isFinite(synthesisResponse.promptCacheTokens) && Number(synthesisResponse.promptCacheTokens) >= 0) modelPromptCacheTokens += Number(synthesisResponse.promptCacheTokens);
      if (Number.isFinite(synthesisResponse.promptEvalTokens) && Number(synthesisResponse.promptEvalTokens) >= 0) modelPromptEvalTokens += Number(synthesisResponse.promptEvalTokens);

      if (!synthesisResponse.mockExhausted && String(synthesisResponse.text || '').trim()) {
        finalOutput = String(synthesisResponse.text).trim();
      } else {
        usedFallback = true;
        finalOutput = buildTerminalSynthesisFallback({ reason, commands });
      }
    } catch (error) {
      options.logger?.write({ kind: 'task_terminal_synthesis_error', taskId: task.id, error: error instanceof Error ? error.message : String(error) });
      usedFallback = true;
      finalOutput = buildTerminalSynthesisFallback({ reason, commands });
    }
    options.logger?.write({ kind: 'task_terminal_synthesis_result', taskId: task.id, usedFallback, finalOutput });
  }

  const evidenceParts = [finalOutput, ...commands.map((item) => item.output)];
  const signalCheck = evaluateTaskSignals(task, evidenceParts.join('\n'));
  const passed = signalCheck.passed && commandFailures === 0;

  options.logger?.write({
    kind: 'task_done', taskId: task.id, reason, turnsUsed, safetyRejects,
    invalidResponses, commandFailures, passed, missingSignals: signalCheck.missingSignals,
  });

  return {
    id: task.id, question: task.question, reason, turnsUsed, safetyRejects,
    invalidResponses, commandFailures, commands, finalOutput, passed,
    missingSignals: signalCheck.missingSignals,
    promptTokens: modelPromptTokens,
    outputTokens: modelOutputTokens,
    toolTokens: modelToolTokens,
    thinkingTokens: modelThinkingTokens,
    promptCacheTokens: modelPromptCacheTokens,
    promptEvalTokens: modelPromptEvalTokens,
    toolStats: { ...toolStatsByType },
    readOverlapSummary: buildReadOverlapSummary(fileReadStateByPath),
  };
}

// ---------------------------------------------------------------------------
// Scorecard
// ---------------------------------------------------------------------------

export type Scorecard = {
  runId: string;
  model: string;
  tasks: TaskResult[];
  totals: Record<string, number>;
  toolStats: Record<string, ToolTypeStats>;
  readOverlapSummary: ReadOverlapSummary;
  verdict: 'pass' | 'fail';
  failureReasons: string[];
};

export function buildScorecard(options: { runId: string; model: string; tasks: TaskResult[] }): Scorecard {
  const totals = {
    tasks: options.tasks.length,
    passed: options.tasks.filter((t) => t.passed).length,
    failed: options.tasks.filter((t) => !t.passed).length,
    commandsExecuted: options.tasks.reduce((s, t) => s + t.commands.length, 0),
    safetyRejects: options.tasks.reduce((s, t) => s + t.safetyRejects, 0),
    invalidResponses: options.tasks.reduce((s, t) => s + t.invalidResponses, 0),
    commandFailures: options.tasks.reduce((s, t) => s + Number(t.commandFailures || 0), 0),
    promptTokens: options.tasks.reduce((s, t) => s + Number(t.promptTokens || 0), 0),
    outputTokens: options.tasks.reduce((s, t) => s + Number(t.outputTokens || 0), 0),
    toolTokens: options.tasks.reduce((s, t) => s + Number(t.toolTokens || 0), 0),
    thinkingTokens: options.tasks.reduce((s, t) => s + Number(t.thinkingTokens || 0), 0),
    promptCacheTokens: options.tasks.reduce((s, t) => s + Number(t.promptCacheTokens || 0), 0),
    promptEvalTokens: options.tasks.reduce((s, t) => s + Number(t.promptEvalTokens || 0), 0),
  };
  const toolStats: Record<string, ToolTypeStats> = {};
  for (const task of options.tasks) {
    Object.assign(toolStats, mergeToolTypeStats(toolStats, task.toolStats || {}));
  }
  const readOverlapSummary = mergeReadOverlapSummaries(options.tasks.map((task) => task.readOverlapSummary));

  const failureReasons: string[] = [];
  for (const task of options.tasks) {
    if (task.passed) continue;
    if (task.missingSignals.length > 0) failureReasons.push(`${task.id}: missing signals [${task.missingSignals.join(', ')}]`);
    if (Number(task.commandFailures || 0) > 0) failureReasons.push(`${task.id}: command failures ${Number(task.commandFailures || 0)}`);
    if (task.missingSignals.length === 0 && Number(task.commandFailures || 0) === 0) failureReasons.push(`${task.id}: task failed`);
  }

  return {
    runId: options.runId,
    model: options.model,
    tasks: options.tasks,
    totals,
    toolStats,
    readOverlapSummary,
    verdict: totals.failed === 0 ? 'pass' : 'fail',
    failureReasons,
  };
}

// ---------------------------------------------------------------------------
// Model assertion
// ---------------------------------------------------------------------------

export function assertConfiguredModelPresent(model: string, availableModels: string[]): void {
  if (!Array.isArray(availableModels) || !availableModels.includes(model)) {
    throw new Error(`Configured model not found: ${model}. Available models: ${Array.isArray(availableModels) ? availableModels.join(', ') : 'none'}`);
  }
}

// ---------------------------------------------------------------------------
// Top-level entry point
// ---------------------------------------------------------------------------

export async function runRepoSearch(options: {
  repoRoot?: string;
  config?: SiftConfig | Record<string, unknown>;
  model?: string;
  baseUrl?: string;
  allowedTools?: string[];
  includeAgentsMd?: boolean;
  includeRepoFileListing?: boolean;
  requestMaxTokens?: number;
  maxTurns?: number;
  thinkingInterval?: number;
  timeoutMs?: number;
  maxInvalidResponses?: number;
  minToolCallsBeforeFinish?: number;
  taskPrompt?: string;
  availableModels?: string[];
  mockResponses?: string[];
  mockCommandResults?: Record<string, RepoSearchMockCommandResult>;
  logger?: JsonLogger | null;
  onProgress?: ((event: RepoSearchProgressEvent) => void) | null;
} = {}): Promise<Scorecard> {
  const plannerToolDefinitions = resolveRepoSearchPlannerToolDefinitions(options.allowedTools);
  if (plannerToolDefinitions.length === 0) {
    throw new Error('No repo-search planner tools are enabled for the active preset.');
  }
  const path = await import('node:path');
  const repoRoot = path.resolve(options.repoRoot || process.cwd());
  const config = (options.config || await loadConfig({ ensure: true })) as SiftConfig;
  const model = options.model || getConfiguredModel(config);
  const baseUrl = options.baseUrl || getConfiguredLlamaBaseUrl(config);

  options.logger?.write({ kind: 'run_start', repoRoot, requestedModel: options.model || null, configuredModel: model, baseUrl });

  const availableModels = options.availableModels || await listLlamaCppModels(config);
  options.logger?.write({ kind: 'model_inventory', configuredModel: model, availableModels });

  const tasksToRun: TaskDefinition[] = options.taskPrompt
    ? [{ id: 'repo-search', question: String(options.taskPrompt), signals: [] }]
    : TASK_PACK;

  const requestMaxTokens = resolveRepoSearchRequestMaxTokens({ config, requestMaxTokens: options.requestMaxTokens });
  const tasks: TaskResult[] = [];

  for (const task of tasksToRun) {
    const result = await runTaskLoop(task, {
      repoRoot,
      model,
      baseUrl,
      config,
      totalContextTokens: getConfiguredLlamaNumCtx(config),
      timeoutMs: options.timeoutMs || DEFAULT_TIMEOUT_MS,
      maxTurns: options.maxTurns || DEFAULT_MAX_TURNS,
      maxInvalidResponses: options.maxInvalidResponses || DEFAULT_MAX_INVALID_RESPONSES,
      minToolCallsBeforeFinish: options.minToolCallsBeforeFinish,
      thinkingInterval: options.thinkingInterval,
      requestMaxTokens,
      plannerToolDefinitions,
      enforceThinkingFinish: true,
      includeAgentsMd: options.includeAgentsMd,
      includeRepoFileListing: options.includeRepoFileListing,
      mockResponses: options.mockResponses,
      mockCommandResults: options.mockCommandResults,
      logger: options.logger || null,
      onProgress: options.onProgress || null,
    });
    tasks.push(result);
  }

  const scorecard = buildScorecard({ runId: randomUUID(), model, tasks });
  options.logger?.write({ kind: 'run_done', scorecard });
  return scorecard;
}

import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
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
  mergeToolTypeStats,
  readLatestIdleSummaryToolStats,
} from '../line-read-guidance.js';
import { spawnDirectCommand } from '../lib/command-spawn.js';
import { spawnPowerShellAsync } from '../lib/powershell.js';
import { getDynamicMaxOutputTokens } from '../lib/dynamic-output-cap.js';
import { ModelJson } from '../lib/model-json.js';
import { colorize } from '../lib/text-format.js';
import type { TemporaryTimingRecorder } from '../lib/temporary-timing-recorder.js';
import { listLlamaCppModels } from '../providers/llama-cpp.js';
import type { ToolTypeStats } from '../status-server/metrics.js';
import {
  buildIgnorePolicy,
  classifySearchExit,
  evaluateCommandSafety,
  getFirstCommandToken,
  type IgnorePolicy,
  normalizePlannerCommand,
  parseDirectRgCommand,
} from './command-safety.js';
import {
  getRepoSearchCommandTokenForToolName,
  isRepoSearchCommandToolName,
  isRepoSearchNativeToolName,
  getRepoSearchToolNamesForParsing,
  resolveRepoSearchPlannerToolDefinitions,
  buildPlannerRequestPromptReserveText,
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
  buildGetContentReadWindowCommand,
  buildReadOverlapSummary,
  computeAdjustedReadWindow,
  getOrCreateFileReadState,
  getPreviousExecutedMaxEnd,
  type LineReadAdjustment,
  LINE_READ_ROUNDING_STEP,
  mergeReadOverlapSummaries,
  mergeRange,
  overlapWithRanges,
  parseGetContentReadWindowCommand,
  REPEATED_LINE_READ_MIN_RATIO,
  type ReadRange,
  type ReadOverlapSummary,
  resolveAvgTokensPerLine,
  type FileReadState,
} from './engine/read-overlap.js';
import {
  buildTaskInitialUserPrompt,
  buildTaskSystemPrompt,
  buildTerminalSynthesisPrompt,
  scanRepoFiles,
  type TaskCommand,
} from './prompts.js';
import {
  buildRepeatedToolCallSummary,
  buildPromptToolResult,
  classifyToolResultNovelty,
  evaluateFinishAttempt,
  fingerprintToolCall,
} from '../tool-loop-governor.js';
import type {
  JsonLogger,
  RepoSearchMockCommandResult,
  RepoSearchProgressEvent,
} from './types.js';
import {
  appendToolCallExchange,
  appendToolBatchExchange,
  buildAssistantToolCallMessage as buildSharedAssistantToolCallMessage,
  type ToolBatchOutcome,
  upsertTrailingUserMessage,
  type ToolTranscriptAction,
  type ToolTranscriptMessage,
} from '../tool-call-messages.js';
import {
  findContiguousUnreadRange,
  ToolOutputFitter,
  type ToolOutputTruncationUnit,
} from '../tool-output-fit.js';

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
const ZERO_OUTPUT_FORCE_THRESHOLD = 10;
const FORCED_FINISH_MAX_ATTEMPTS = 3;
const DUPLICATE_FORCE_THRESHOLD = 5;
const ANSI_RED_CODE = 31;

function getAbortError(abortSignal?: AbortSignal): Error {
  return abortSignal?.reason instanceof Error
    ? abortSignal.reason
    : new Error(String(abortSignal?.reason || 'Repo search aborted.'));
}

function throwIfAborted(abortSignal?: AbortSignal): void {
  if (abortSignal?.aborted) {
    throw getAbortError(abortSignal);
  }
}

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

type NativeRepoToolExecution =
  | {
    ok: true;
    requestedCommand?: string;
    command: string;
    exitCode: number;
    output: string;
    toolType: string;
    readFile?: {
      commandPath: string;
      pathKey: string;
      displayPath: string;
      startLine: number;
      endLineExclusive: number;
      totalEndLineExclusive: number;
    };
    outputUnit?: ToolOutputTruncationUnit;
    lineReadStats?: {
      lineReadCalls: number;
      lineReadLinesTotal: number;
      lineReadTokensTotal: number;
    };
  }
  | {
    ok: false;
    command: string;
    reason: string;
    toolType: string;
  };

type RepoReadFilePlan = {
  requestedCommand: string;
  commandPath: string;
  requestedStartLine: number;
  requestedEndLine: number;
  effectiveStartLine: number;
  effectiveEndLineExclusive: number;
  totalEndLineExclusive: number;
  pathKey: string;
  displayPath: string;
  lines: string[];
  hasUnread: boolean;
  noUnreadOutput: string | null;
};

function isFailedRepoReadFilePlan(
  plan: RepoReadFilePlan | { ok: false; command: string; reason: string },
): plan is { ok: false; command: string; reason: string } {
  return 'ok' in plan && plan.ok === false;
}

type EffectiveTranscriptActionOptions = {
  toolName: string;
  rawArgs: Record<string, unknown>;
  isNativeTool: boolean;
  commandToRun: string;
};

function parseEffectiveReadFileArgs(command: string, fallbackArgs: Record<string, unknown>): Record<string, unknown> {
  const match = /^repo_read_file path=("(?:(?:\\")|[^"])*"|\S+) startLine=(\d+)(?: endLine=(\d+))?/u.exec(command.trim());
  if (!match) {
    return fallbackArgs;
  }
  let pathText = String(fallbackArgs.path || '');
  try {
    pathText = JSON.parse(match[1]) as string;
  } catch {
    pathText = String(fallbackArgs.path || '');
  }
  return {
    path: pathText,
    startLine: Number.parseInt(match[2], 10),
    ...(match[3] ? { endLine: Number.parseInt(match[3], 10) } : {}),
  };
}

function buildEffectiveTranscriptAction(options: EffectiveTranscriptActionOptions): ToolTranscriptAction {
  if (!options.isNativeTool) {
    return {
      tool_name: options.toolName,
      args: { command: options.commandToRun },
    };
  }

  if (options.toolName === 'repo_read_file') {
    return {
      tool_name: options.toolName,
      args: parseEffectiveReadFileArgs(options.commandToRun, options.rawArgs),
    };
  }

  return {
    tool_name: options.toolName,
    args: options.rawArgs,
  };
}

function normalizeRepoRelativePathForDisplay(relativePath: string): string {
  return relativePath.replace(/\\/gu, '/');
}

function isRepoRelativePathIgnored(relativePath: string, ignorePolicy: IgnorePolicy): boolean {
  const normalized = normalizeRepoRelativePathForDisplay(relativePath).replace(/^\.\/+/u, '');
  if (!normalized) {
    return false;
  }
  const segments = normalized.split('/').filter(Boolean);
  if (segments.some((segment) => ignorePolicy.namesLower.has(segment.toLowerCase()))) {
    return true;
  }
  return ignorePolicy.paths.some((ignoredPath) => (
    normalized === ignoredPath || normalized.startsWith(`${ignoredPath}/`)
  ));
}

function resolveRepoScopedPath(repoRoot: string, rawPath: unknown): {
  absolutePath: string;
  relativePath: string;
} | null {
  const pathText = typeof rawPath === 'string' ? rawPath.trim() : '';
  if (!pathText) {
    return null;
  }
  const absolutePath = path.resolve(repoRoot, pathText);
  const relativePath = path.relative(repoRoot, absolutePath);
  if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
    return null;
  }
  return {
    absolutePath,
    relativePath: normalizeRepoRelativePathForDisplay(relativePath),
  };
}

function globToRegExp(glob: string): RegExp {
  let pattern = '^';
  for (let index = 0; index < glob.length; index += 1) {
    const char = glob[index];
    if (char === '*') {
      const next = glob[index + 1];
      if (next === '*') {
        pattern += '.*';
        index += 1;
        continue;
      }
      pattern += '[^/]*';
      continue;
    }
    if (char === '?') {
      pattern += '[^/]';
      continue;
    }
    if ('\\.[]{}()+^$|'.includes(char)) {
      pattern += `\\${char}`;
      continue;
    }
    pattern += char === '\\' ? '/' : char;
  }
  pattern += '$';
  return new RegExp(pattern, 'iu');
}

function matchesRepoListGlob(relativePath: string, globText: string): boolean {
  const normalizedPath = normalizeRepoRelativePathForDisplay(relativePath);
  const normalizedGlob = normalizeRepoRelativePathForDisplay(globText.trim());
  if (!normalizedGlob) {
    return true;
  }
  const target = normalizedGlob.includes('/') ? normalizedPath : path.posix.basename(normalizedPath);
  return globToRegExp(normalizedGlob).test(target);
}

function formatNumberedTextBlock(lines: string[], startLine: number): string {
  return lines.map((line, index) => `${startLine + index}: ${line}`).join('\n');
}

function buildRepoReadFileCommand(pathText: string, startLine: number, endLine?: number): string {
  const boundedStartLine = Math.max(1, Math.trunc(Number(startLine) || 1));
  const boundedEndLine = Math.trunc(Number(endLine) || 0);
  return `repo_read_file path=${JSON.stringify(pathText)} startLine=${boundedStartLine}${boundedEndLine > 0 ? ` endLine=${boundedEndLine}` : ''}`;
}

function buildRepoListFilesCommand(args: Record<string, unknown>): string {
  const pathText = typeof args.path === 'string' && args.path.trim() ? args.path.trim() : '.';
  const recurse = args.recurse === undefined ? true : args.recurse === true;
  const globText = typeof args.glob === 'string' ? args.glob.trim() : '';
  return `repo_list_files path=${JSON.stringify(pathText)}${globText ? ` glob=${JSON.stringify(globText)}` : ''} recurse=${recurse}`;
}

function buildNativeRepoToolRequestedCommand(toolName: string, args: Record<string, unknown>): string {
  if (toolName === 'repo_read_file') {
    const startLine = Math.max(1, Math.trunc(Number(args.startLine) || 1));
    const endLineCandidate = Math.trunc(Number(args.endLine) || 0);
    return buildRepoReadFileCommand(String(args.path || ''), startLine, endLineCandidate > 0 ? endLineCandidate : undefined);
  }
  return buildRepoListFilesCommand(args);
}

function planRepoReadFile(
  args: Record<string, unknown>,
  repoRoot: string,
  ignorePolicy: IgnorePolicy,
  fileReadStateByPath?: Map<string, FileReadState>,
): RepoReadFilePlan | { ok: false; command: string; reason: string } {
  const commandPath = String(args.path || '');
  const startLine = Math.max(1, Math.trunc(Number(args.startLine) || 1));
  const endLineCandidate = Math.trunc(Number(args.endLine) || 0);
  const requestedCommand = buildRepoReadFileCommand(commandPath, startLine, endLineCandidate > 0 ? endLineCandidate : undefined);
  const resolvedPath = resolveRepoScopedPath(repoRoot, args.path);
  if (!resolvedPath) {
    return { ok: false, command: requestedCommand, reason: 'path must stay within the repository root' };
  }
  if (isRepoRelativePathIgnored(resolvedPath.relativePath, ignorePolicy)) {
    return { ok: false, command: requestedCommand, reason: 'path is ignored by runtime policy' };
  }
  if (!fs.existsSync(resolvedPath.absolutePath) || !fs.statSync(resolvedPath.absolutePath).isFile()) {
    return { ok: false, command: requestedCommand, reason: 'path is not a readable file' };
  }

  const lines = fs.readFileSync(resolvedPath.absolutePath, 'utf8').replace(/\r\n/gu, '\n').split('\n');
  const pathKey = normalizeRepoRelativePathForDisplay(resolvedPath.relativePath).toLowerCase();
  const displayPath = normalizeRepoRelativePathForDisplay(resolvedPath.relativePath);
  const totalEndLineExclusive = (lines.length || 0) + 1;
  const clampedStart = Math.min(startLine, lines.length || 1);
  const requestedEnd = endLineCandidate > 0 ? endLineCandidate : lines.length;
  const requestedEndExclusive = Math.max(clampedStart + 1, Math.min(requestedEnd + 1, totalEndLineExclusive));
  const state = fileReadStateByPath ? getOrCreateFileReadState(fileReadStateByPath, pathKey) : null;
  const hasReturnedRanges = Boolean(state && state.mergedReturnedRanges.length > 0);
  const unreadRange = findContiguousUnreadRange({
    requestedStart: clampedStart,
    totalEnd: hasReturnedRanges ? totalEndLineExclusive : requestedEndExclusive,
    returnedRanges: state?.mergedReturnedRanges || [],
  });

  return {
    requestedCommand,
    commandPath,
    requestedStartLine: clampedStart,
    requestedEndLine: requestedEndExclusive - 1,
    effectiveStartLine: unreadRange.start,
    effectiveEndLineExclusive: unreadRange.end,
    totalEndLineExclusive,
    pathKey,
    displayPath,
    lines,
    hasUnread: unreadRange.hasUnread,
    noUnreadOutput: unreadRange.hasUnread ? null : `No unread lines remain for ${displayPath}.`,
  };
}

function buildRepoReadFileExecution(
  toolName: string,
  plan: RepoReadFilePlan,
  noteText: string | null,
): NativeRepoToolExecution {
  if (!plan.hasUnread) {
    const output = [noteText, plan.noUnreadOutput || ''].filter((part) => String(part || '').trim()).join('\n').trim();
    return {
      ok: true,
      requestedCommand: plan.requestedCommand,
      command: plan.requestedCommand,
      exitCode: 0,
      output,
      toolType: toolName,
      outputUnit: 'lines',
      readFile: {
        commandPath: plan.commandPath,
        pathKey: plan.pathKey,
        displayPath: plan.displayPath,
        startLine: plan.effectiveStartLine,
        endLineExclusive: plan.effectiveStartLine,
        totalEndLineExclusive: plan.totalEndLineExclusive,
      },
      lineReadStats: {
        lineReadCalls: 0,
        lineReadLinesTotal: 0,
        lineReadTokensTotal: 0,
      },
    };
  }

  const selectedLines = plan.lines.slice(plan.effectiveStartLine - 1, plan.effectiveEndLineExclusive - 1);
  const output = [noteText, formatNumberedTextBlock(selectedLines, plan.effectiveStartLine)]
    .filter((part) => String(part || '').trim())
    .join('\n')
    .trim();
  const executedCommand = buildRepoReadFileCommand(plan.commandPath, plan.effectiveStartLine, plan.effectiveEndLineExclusive - 1);
  return {
    ok: true,
    requestedCommand: plan.requestedCommand,
    command: executedCommand,
    exitCode: 0,
    output,
    toolType: toolName,
    outputUnit: 'lines',
    readFile: {
      commandPath: plan.commandPath,
      pathKey: plan.pathKey,
      displayPath: plan.displayPath,
      startLine: plan.effectiveStartLine,
      endLineExclusive: plan.effectiveEndLineExclusive,
      totalEndLineExclusive: plan.totalEndLineExclusive,
    },
    lineReadStats: {
      lineReadCalls: 1,
      lineReadLinesTotal: selectedLines.length,
      lineReadTokensTotal: Math.max(1, estimateTokenCount(undefined, selectedLines.join('\n'))),
    },
  };
}

function listRepoFilesRecursive(
  currentAbsolutePath: string,
  currentRelativePath: string,
  ignorePolicy: IgnorePolicy,
  includeFiles: string[],
  recurse: boolean,
): void {
  for (const entry of fs.readdirSync(currentAbsolutePath, { withFileTypes: true })) {
    const nextRelativePath = currentRelativePath
      ? `${currentRelativePath}/${entry.name}`
      : entry.name;
    if (isRepoRelativePathIgnored(nextRelativePath, ignorePolicy)) {
      continue;
    }
    const nextAbsolutePath = path.join(currentAbsolutePath, entry.name);
    if (entry.isDirectory()) {
      if (recurse) {
        listRepoFilesRecursive(nextAbsolutePath, nextRelativePath, ignorePolicy, includeFiles, recurse);
      }
      continue;
    }
    if (entry.isFile()) {
      includeFiles.push(normalizeRepoRelativePathForDisplay(nextRelativePath));
    }
  }
}

function executeNativeRepoTool(
  toolName: string,
  args: Record<string, unknown>,
  repoRoot: string,
  ignorePolicy: IgnorePolicy,
  fileReadStateByPath?: Map<string, FileReadState>,
): NativeRepoToolExecution {
  if (toolName === 'repo_read_file') {
    const plan = planRepoReadFile(args, repoRoot, ignorePolicy, fileReadStateByPath);
    if (isFailedRepoReadFilePlan(plan)) {
      return { ok: false, command: plan.command, reason: plan.reason, toolType: toolName };
    }
    return buildRepoReadFileExecution(toolName, plan, null);
  }

  const pathText = typeof args.path === 'string' && args.path.trim() ? args.path.trim() : '.';
  const recurse = args.recurse === undefined ? true : args.recurse === true;
  const globText = typeof args.glob === 'string' ? args.glob.trim() : '';
  const command = buildRepoListFilesCommand(args);
  const resolvedPath = resolveRepoScopedPath(repoRoot, pathText);
  if (!resolvedPath) {
    return { ok: false, command, reason: 'path must stay within the repository root', toolType: toolName };
  }
  if (isRepoRelativePathIgnored(resolvedPath.relativePath, ignorePolicy)) {
    return { ok: false, command, reason: 'path is ignored by runtime policy', toolType: toolName };
  }
  if (!fs.existsSync(resolvedPath.absolutePath) || !fs.statSync(resolvedPath.absolutePath).isDirectory()) {
    return { ok: false, command, reason: 'path is not a readable directory', toolType: toolName };
  }
  const matches: string[] = [];
  listRepoFilesRecursive(
    resolvedPath.absolutePath,
    resolvedPath.relativePath === '.' ? '' : resolvedPath.relativePath,
    ignorePolicy,
    matches,
    recurse,
  );
  const filteredMatches = globText
    ? matches.filter((relativePath) => matchesRepoListGlob(relativePath, globText))
    : matches;
  return {
    ok: true,
    requestedCommand: command,
    command,
    exitCode: 0,
    output: filteredMatches.join('\n'),
    toolType: toolName,
    outputUnit: 'files',
  };
}

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
  abortSignal?: AbortSignal,
): Promise<{ exitCode: number; output: string }> {
  throwIfAborted(abortSignal);
  const mockResult = mockCommandResults ? findMockResult(command, mockCommandResults) : null;
  if (mockResult) {
    const delayMs = Number(mockResult.delayMs ?? 0);
    return new Promise((resolve, reject) => {
      let timeoutHandle: NodeJS.Timeout | null = null;
      const cleanup = (): void => {
        if (timeoutHandle) {
          clearTimeout(timeoutHandle);
          timeoutHandle = null;
        }
        abortSignal?.removeEventListener('abort', abort);
      };
      const abort = (): void => {
        cleanup();
        reject(getAbortError(abortSignal));
      };
      const complete = (): void => {
        cleanup();
        resolve({
          exitCode: Number(mockResult.exitCode ?? 1),
          output: `${String(mockResult.stdout || '')}${String(mockResult.stderr || '')}`.trim(),
        });
      };
      if (abortSignal?.aborted) {
        abort();
        return;
      }
      abortSignal?.addEventListener('abort', abort, { once: true });
      if (Number.isFinite(delayMs) && delayMs > 0) {
        timeoutHandle = setTimeout(complete, delayMs);
      } else {
        complete();
      }
    });
  }

  const directRg = parseDirectRgCommand(command);
  if (directRg) {
    return spawnDirectCommand('rg', directRg.args, { cwd: repoRoot, abortSignal }).then((result) => ({
      exitCode: result.exitCode,
      output: result.output,
    }));
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
// Console helper
// ---------------------------------------------------------------------------

function writeRedConsoleLine(message: string): void {
  if (!message) return;
  process.stderr.write(`${colorize(String(message), ANSI_RED_CODE, { isTTY: true })}\n`);
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
  promptEvalDurationMs: number;
  generationDurationMs: number;
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
  plannerToolDefinitions?: ReturnType<typeof resolveRepoSearchPlannerToolDefinitions>;
  includeAgentsMd?: boolean;
  includeRepoFileListing?: boolean;
  mockResponses?: string[];
  mockCommandResults?: Record<string, RepoSearchMockCommandResult>;
  abortSignal?: AbortSignal;
  logger?: JsonLogger | null;
  onProgress?: ((event: RepoSearchProgressEvent) => void) | null;
  timingRecorder?: TemporaryTimingRecorder | null;
};

function isPlannerReasoningEnabled(config: SiftConfig | undefined): boolean {
  return getConfiguredLlamaSetting(config || {} as SiftConfig, 'Reasoning') === 'on';
}

function isPlannerReasoningContentEnabled(config: SiftConfig | undefined): boolean {
  return isPlannerReasoningEnabled(config) && config?.Server?.LlamaCpp?.ReasoningContent === true;
}

function isPlannerPreserveThinkingEnabled(config: SiftConfig | undefined): boolean {
  return isPlannerReasoningContentEnabled(config) && config?.Server?.LlamaCpp?.PreserveThinking === true;
}

function buildAssistantReplayMessage(content: string, thinkingText: string): ChatMessage {
  return {
    role: 'assistant',
    content,
    ...(thinkingText ? { reasoning_content: thinkingText } : {}),
  };
}

function buildAssistantToolCallMessage(
  toolName: string,
  args: Record<string, unknown>,
  toolCallId: string,
  thinkingText: string
): ChatMessage {
  return buildSharedAssistantToolCallMessage({ tool_name: toolName, args }, toolCallId, thinkingText) as ChatMessage;
}

function buildInvalidToolCallActionFromResponseText(
  responseText: string,
  allowedToolNames: readonly string[]
): ToolTranscriptAction {
  try {
    const action = ModelJson.parseRepoSearchPlannerAction(responseText, { allowedToolNames });
    if (action.action === 'tool') {
      return action;
    }
    if (action.action === 'tool_batch') {
      const firstToolCall = action.tool_calls[0];
      if (firstToolCall) {
        return {
          tool_name: firstToolCall.tool_name,
          args: firstToolCall.args,
        };
      }
    }
  } catch {
    // Invalid responses are fed back to the model as an explicit invalid tool call.
  }
  return {
    tool_name: 'invalid_tool_call',
    args: {
      rawResponseText: String(responseText || '').trim(),
    },
  };
}

export async function runTaskLoop(task: TaskDefinition, options: RunTaskLoopOptions): Promise<TaskResult> {
  const taskStartedAt = Date.now();
  const maxTurns = Math.max(1, Number(options.maxTurns || DEFAULT_MAX_TURNS));
  const maxInvalidResponses = Math.max(1, Number(options.maxInvalidResponses || DEFAULT_MAX_INVALID_RESPONSES));
  const commands: TaskCommand[] = [];
  let finalOutput = '';
  let invalidResponses = 0;
  let commandFailures = 0;
  let safetyRejects = 0;
  let reason = 'max_turns';
  let turnsUsed = 0;
  let mockResponseIndex = 0;
  let modelPromptTokens = 0;
  let modelOutputTokens = 0;
  let modelToolTokens = 0;
  let modelThinkingTokens = 0;
  let modelPromptCacheTokens = 0;
  let modelPromptEvalTokens = 0;
  let modelPromptEvalDurationMs = 0;
  let modelGenerationDurationMs = 0;
  const toolStatsByType: Record<string, ToolTypeStats> = {};
  const minToolCallsBeforeFinish = Math.max(0, Number(options.minToolCallsBeforeFinish ?? MIN_TOOL_CALLS_BEFORE_FINISH));
  const totalContextTokens = Math.max(1, Number(options.totalContextTokens || (options.config ? getConfiguredLlamaNumCtx(options.config) : 32000)));
  const thinkingBufferTokens = Math.max(Math.ceil(totalContextTokens * THINKING_BUFFER_RATIO), THINKING_BUFFER_MIN_TOKENS);
  const usablePromptTokens = Math.max(totalContextTokens - thinkingBufferTokens, 0);
  const useEstimatedTokensOnly = Array.isArray(options.mockResponses);
  const plannerThinkingEnabled = isPlannerReasoningEnabled(options.config);
  const plannerReasoningContentEnabled = isPlannerReasoningContentEnabled(options.config);
  const plannerPreserveThinkingEnabled = isPlannerPreserveThinkingEnabled(options.config);
  const plannerToolDefinitions = Array.isArray(options.plannerToolDefinitions) && options.plannerToolDefinitions.length > 0
    ? options.plannerToolDefinitions
    : resolveRepoSearchPlannerToolDefinitions();
  const allowedPlannerToolNames = Array.from(new Set<string>([
    ...plannerToolDefinitions.map((toolDefinition) => toolDefinition.function.name),
    ...getRepoSearchToolNamesForParsing(),
  ]));
  let zeroOutputStreak = 0;
  let forcedFinishAttemptsRemaining = 0;
  let lastLoggedMessageCount = 0;
  const slotId = options.config ? allocateLlamaCppSlotId(options.config) : 0;
  const ignorePolicy = buildIgnorePolicy(options.repoRoot);
  const bootstrapFileListSpan = options.timingRecorder?.start('repo.bootstrap.file_listing', {
    taskId: task.id,
    enabled: options.includeRepoFileListing !== false,
  });
  const bootstrapFileList = options.includeRepoFileListing === false
    ? undefined
    : (scanRepoFiles(options.repoRoot, ignorePolicy) || undefined);
  bootstrapFileListSpan?.end({
    fileCount: Array.isArray(bootstrapFileList) ? bootstrapFileList.length : 0,
  });
  const historicalToolStats = readLatestIdleSummaryToolStats();
  const recentEvidenceKeys = new Set<string>();
  const successfulToolCalls: Array<{ toolName: string; promptResultText: string }> = [];
  let lastSuccessfulNormalizedKey: string | null = null;
  let lastSuccessfulFingerprint: string | null = null;
  let duplicateReplayFingerprint: string | null = null;
  let duplicateReplayCount = 0;
  let duplicateReplayToolMessageIndex = -1;
  let forcedFinishCountdownUserMessageIndex = -1;
  const fileReadCountByPath = new Map<string, number>();
  const fileReadStateByPath = new Map<string, FileReadState>();

  const messages: ChatMessage[] = [
    {
      role: 'system',
      content: buildTaskSystemPrompt(options.repoRoot, {
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
    throwIfAborted(options.abortSignal);
    turnsUsed = turn;
    const inForcedFinishMode = forcedFinishAttemptsRemaining > 0;

    const promptRenderSpan = options.timingRecorder?.start('repo.prompt.render', {
      taskId: task.id,
      turn,
      messageCount: messages.length,
    });
    let providerPromptReserveText = buildPlannerRequestPromptReserveText({
      stage: 'planner_action',
      model: String(options.model || ''),
      messageRoles: messages.map((message) => String(message.role || 'unknown')),
      toolDefinitions: plannerToolDefinitions,
      maxTokens: totalContextTokens,
      thinkingEnabled: plannerThinkingEnabled,
      reasoningContentEnabled: plannerReasoningContentEnabled,
      preserveThinking: plannerPreserveThinkingEnabled,
      stream: Boolean(options.onProgress),
    });
    let prompt = renderTaskTranscript(messages);
    promptRenderSpan?.end({ promptChars: prompt.length, providerPromptReserveChars: providerPromptReserveText.length });
    const preflightSpan = options.timingRecorder?.start('repo.prompt.preflight', {
      taskId: task.id,
      turn,
    });
    options.onProgress?.({
      kind: 'preflight_start',
      taskId: task.id,
      turn,
      maxTurns,
      promptChars: prompt.length,
      elapsedMs: Date.now() - taskStartedAt,
    });
    const preflightConfig = useEstimatedTokensOnly ? undefined : options.config;
    if (preflightConfig) {
      options.onProgress?.({
        kind: 'preflight_tokenize_start',
        taskId: task.id,
        turn,
        maxTurns,
        promptChars: prompt.length,
        tokenizeTimeoutMs: 10_000,
        tokenizeRetryMaxWaitMs: 30_000,
        elapsedMs: Date.now() - taskStartedAt,
      });
    }
    let preflight = await preflightPlannerPromptBudget({
      config: preflightConfig,
      prompt,
      providerPromptReserveText,
      totalContextTokens,
      thinkingBufferTokens,
    });
    preflightSpan?.end({
      promptTokenCount: preflight.promptTokenCount,
      overflowTokens: preflight.overflowTokens,
      ok: preflight.ok,
    });
    options.onProgress?.({
      kind: 'preflight_done',
      taskId: task.id,
      turn,
      maxTurns,
      promptChars: prompt.length,
      promptTokenCount: preflight.promptTokenCount,
      elapsedMs: Date.now() - taskStartedAt,
    });
    if (preflight.tokenizationAttempted) {
      options.onProgress?.({
        kind: 'preflight_tokenize_done',
        taskId: task.id,
        turn,
        maxTurns,
        promptChars: prompt.length,
        promptTokenCount: preflight.promptTokenCount,
        tokenCountSource: preflight.tokenCountSource,
        tokenizeElapsedMs: preflight.tokenizeElapsedMs ?? undefined,
        tokenizeRetryCount: preflight.tokenizeRetryCount ?? undefined,
        tokenizeTimeoutMs: preflight.tokenizeTimeoutMs,
        tokenizeRetryMaxWaitMs: preflight.tokenizeRetryMaxWaitMs,
        tokenizeStatus: preflight.tokenizeStatus ?? undefined,
        errorMessage: preflight.tokenizeErrorMessage ?? undefined,
        elapsedMs: Date.now() - taskStartedAt,
      });
    }
    let maxOutputTokens = getDynamicMaxOutputTokens({
      totalContextTokens,
      promptTokenCount: preflight.promptTokenCount,
    });

    options.logger?.write({
      kind: 'turn_preflight_budget', taskId: task.id, turn,
      promptTokenCount: preflight.promptTokenCount,
      transcriptPromptTokenCount: preflight.transcriptPromptTokenCount,
      providerPromptReserveTokenCount: preflight.providerPromptReserveTokenCount,
      maxPromptBudget: preflight.maxPromptBudget,
      overflowTokens: preflight.overflowTokens, ok: preflight.ok, compacted: false, maxOutputTokens,
    });

    if (!preflight.ok) {
      const compactionSpan = options.timingRecorder?.start('repo.prompt.compact', {
        taskId: task.id,
        turn,
        beforePromptTokenCount: preflight.promptTokenCount,
      });
      const compacted = await compactPlannerMessagesOnce({
        messages,
        config: useEstimatedTokensOnly ? undefined : options.config,
        maxPromptBudget: preflight.maxPromptBudget,
        providerPromptReserveText,
      });
      messages.splice(0, messages.length, ...compacted.messages);
      lastLoggedMessageCount = 0;
      const beforeProviderPromptReserveTokenCount = preflight.providerPromptReserveTokenCount;
      providerPromptReserveText = buildPlannerRequestPromptReserveText({
        stage: 'planner_action',
        model: String(options.model || ''),
        messageRoles: messages.map((message) => String(message.role || 'unknown')),
        toolDefinitions: plannerToolDefinitions,
        maxTokens: totalContextTokens,
        thinkingEnabled: plannerThinkingEnabled,
        reasoningContentEnabled: plannerReasoningContentEnabled,
        preserveThinking: plannerPreserveThinkingEnabled,
        stream: Boolean(options.onProgress),
      });
      prompt = renderTaskTranscript(messages);
      if (preflightConfig) {
        options.onProgress?.({
          kind: 'preflight_tokenize_start',
          taskId: task.id,
          turn,
          maxTurns,
          promptChars: prompt.length,
          tokenizeTimeoutMs: 10_000,
          tokenizeRetryMaxWaitMs: 30_000,
          elapsedMs: Date.now() - taskStartedAt,
        });
      }
      const afterCompaction = await preflightPlannerPromptBudget({
        config: preflightConfig, prompt, providerPromptReserveText, totalContextTokens, thinkingBufferTokens,
      });
      if (afterCompaction.tokenizationAttempted) {
        options.onProgress?.({
          kind: 'preflight_tokenize_done',
          taskId: task.id,
          turn,
          maxTurns,
          promptChars: prompt.length,
          promptTokenCount: afterCompaction.promptTokenCount,
          tokenCountSource: afterCompaction.tokenCountSource,
          tokenizeElapsedMs: afterCompaction.tokenizeElapsedMs ?? undefined,
          tokenizeRetryCount: afterCompaction.tokenizeRetryCount ?? undefined,
          tokenizeTimeoutMs: afterCompaction.tokenizeTimeoutMs,
          tokenizeRetryMaxWaitMs: afterCompaction.tokenizeRetryMaxWaitMs,
          tokenizeStatus: afterCompaction.tokenizeStatus ?? undefined,
          errorMessage: afterCompaction.tokenizeErrorMessage ?? undefined,
          elapsedMs: Date.now() - taskStartedAt,
        });
      }
      compactionSpan?.end({
        afterPromptTokenCount: afterCompaction.promptTokenCount,
        droppedMessageCount: compacted.droppedMessageCount,
      });
      maxOutputTokens = getDynamicMaxOutputTokens({
        totalContextTokens,
        promptTokenCount: afterCompaction.promptTokenCount,
      });
      options.logger?.write({
        kind: 'turn_preflight_compaction_applied', taskId: task.id, turn,
        beforePromptTokenCount: preflight.promptTokenCount,
        afterPromptTokenCount: afterCompaction.promptTokenCount,
        transcriptPromptTokenCount: afterCompaction.transcriptPromptTokenCount,
        beforeProviderPromptReserveTokenCount,
        providerPromptReserveTokenCount: afterCompaction.providerPromptReserveTokenCount,
        maxPromptBudget: afterCompaction.maxPromptBudget,
        droppedMessageCount: compacted.droppedMessageCount,
        summaryInserted: compacted.summaryInserted,
        maxOutputTokens,
      });
      preflight = afterCompaction;
    }

    if (!preflight.ok) {
      const overflowError = new Error(
        `planner_preflight_overflow prompt_tokens=${preflight.promptTokenCount} `
        + `max_prompt_tokens=${preflight.maxPromptBudget} overflow_tokens=${preflight.overflowTokens} `
        + `max_output_tokens=${maxOutputTokens} total_context_tokens=${totalContextTokens} `
        + `thinking_buffer_tokens=${thinkingBufferTokens}`,
      );
      options.logger?.write({
        kind: 'turn_preflight_overflow_fail', taskId: task.id, turn,
        promptTokenCount: preflight.promptTokenCount,
        transcriptPromptTokenCount: preflight.transcriptPromptTokenCount,
        providerPromptReserveTokenCount: preflight.providerPromptReserveTokenCount,
        maxPromptBudget: preflight.maxPromptBudget,
        overflowTokens: preflight.overflowTokens, maxOutputTokens, totalContextTokens, thinkingBufferTokens,
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

    const providerSpan = options.timingRecorder?.start('repo.llama.request', {
      taskId: task.id,
      turn,
      promptTokenCount: preflight.promptTokenCount,
      maxOutputTokens,
      mock: Array.isArray(options.mockResponses),
    });
    let response: PlannerActionResponse;
    try {
      response = await requestPlannerAction({
        baseUrl: options.baseUrl,
        model: options.model,
        messages,
        slotId,
        timeoutMs: options.timeoutMs || DEFAULT_TIMEOUT_MS,
        maxTokens: maxOutputTokens,
        thinkingEnabled: plannerThinkingEnabled,
        reasoningContentEnabled: plannerReasoningContentEnabled,
        preserveThinking: plannerPreserveThinkingEnabled,
        stream: Boolean(options.onProgress),
        onThinkingDelta: options.onProgress
          ? (accThinking) => { options.onProgress!({ kind: 'thinking', turn, maxTurns, thinkingText: accThinking }); }
          : undefined,
        onContentDelta: options.onProgress
          ? (accContent) => { options.onProgress!({ kind: 'thinking', turn, maxTurns, thinkingText: accContent }); }
          : undefined,
        mockResponses: options.mockResponses,
        mockResponseIndex,
        abortSignal: options.abortSignal,
        logger: options.logger || null,
        toolDefinitions: plannerToolDefinitions,
      });
    } finally {
      providerSpan?.end();
    }

    if (options.onProgress) {
      options.onProgress({ kind: 'llm_end', turn, maxTurns, promptTokenCount: preflight.promptTokenCount, elapsedMs: Date.now() - taskStartedAt });
    }
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
    if (Number.isFinite(response.promptEvalDurationMs) && Number(response.promptEvalDurationMs) >= 0) modelPromptEvalDurationMs += Number(response.promptEvalDurationMs);
    if (Number.isFinite(response.generationDurationMs) && Number(response.generationDurationMs) >= 0) modelGenerationDurationMs += Number(response.generationDurationMs);

    if (response.mockExhausted) { reason = 'mock_responses_exhausted'; break; }

    let action;
    const parseSpan = options.timingRecorder?.start('repo.response.parse', {
      taskId: task.id,
      turn,
      responseChars: String(response.text || '').length,
    });
    try {
      action = ModelJson.parseRepoSearchPlannerAction(response.text, { allowedToolNames: allowedPlannerToolNames });
      parseSpan?.end({ ok: true });
      options.logger?.write({ kind: 'turn_action_parsed', taskId: task.id, turn, action });
    } catch (error) {
      parseSpan?.end({ ok: false });
      modelOutputTokens += resolvedCompletionTokens;
      invalidResponses += 1;
      const invalidActionMessage = `Invalid action: ${error instanceof Error ? error.message : String(error)}. Return a valid JSON finish action or tool action payload.`;
      const invalidToolAction = buildInvalidToolCallActionFromResponseText(String(response.text || ''), allowedPlannerToolNames);
      appendToolCallExchange(
        messages as unknown as ToolTranscriptMessage[],
        invalidToolAction,
        `invalid_call_${invalidResponses}`,
        invalidActionMessage,
        String(response.thinkingText || '').trim(),
      );
      options.logger?.write({
        kind: 'turn_action_invalid',
        taskId: task.id,
        turn,
        invalidResponses,
        error: error instanceof Error ? error.message : String(error),
        toolAction: invalidToolAction,
        toolResultText: invalidActionMessage,
      });
      if (invalidResponses >= maxInvalidResponses) { reason = 'invalid_response_limit'; break; }
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
        messages.push(buildAssistantReplayMessage(response.text, String(response.thinkingText || '').trim()));
        messages.push({ role: 'user', content: warning });
        options.logger?.write({ kind: 'turn_finish_rejected', taskId: task.id, turn, toolCallTurns: commands.length, minToolCallsBeforeFinish, warning });
        continue;
      }
      finalOutput = action.output;
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

    const batchOutcomes: ToolBatchOutcome[] = [];
    const pendingModeChangeUserMessages: string[] = [];
    let pendingForcedFinishCountdownText: string | null = null;
    let batchDuplicateAnchorIndex: number | null = null;
    let acceptedToolPromptTokensThisTurn = 0;

    for (const toolAction of toolActions) {
      const normalizedToolName = String(toolAction.tool_name || '').trim().toLowerCase();
      const isCommandTool = isRepoSearchCommandToolName(normalizedToolName);
      const isNativeTool = isRepoSearchNativeToolName(normalizedToolName);
      if (!isCommandTool && !isNativeTool) {
        invalidResponses += 1;
        const unsupportedToolMessage = `Invalid action: unsupported planner tool "${toolAction.tool_name}" for repo-search. Use one of: ${allowedPlannerToolNames.join(', ')}.`;
        batchOutcomes.push({
          action: { tool_name: String(toolAction.tool_name || '').trim() || 'invalid_tool_call', args: toolAction.args },
          toolCallId: `invalid_call_${invalidResponses}`,
          toolContent: unsupportedToolMessage,
        });
        options.logger?.write({
          kind: 'turn_action_invalid',
          taskId: task.id,
          turn,
          invalidResponses,
          error: unsupportedToolMessage,
          toolAction,
          toolResultText: unsupportedToolMessage,
        });
        if (invalidResponses >= maxInvalidResponses) { reason = 'invalid_response_limit'; break; }
        continue;
      }
      let nativeExecution: NativeRepoToolExecution | null = null;
      const command = isCommandTool
        ? (typeof toolAction.args.command === 'string' ? toolAction.args.command : '')
        : buildNativeRepoToolRequestedCommand(normalizedToolName, toolAction.args);
      if (isCommandTool && !command.trim()) {
        invalidResponses += 1;
        const invalidCommandMessage = `Invalid action: ${normalizedToolName} requires args.command.`;
        batchOutcomes.push({
          action: { tool_name: normalizedToolName, args: toolAction.args },
          toolCallId: `invalid_call_${invalidResponses}`,
          toolContent: invalidCommandMessage,
        });
        options.logger?.write({
          kind: 'turn_action_invalid',
          taskId: task.id,
          turn,
          invalidResponses,
          error: invalidCommandMessage,
          toolAction,
          toolResultText: invalidCommandMessage,
        });
        if (invalidResponses >= maxInvalidResponses) { reason = 'invalid_response_limit'; break; }
        continue;
      }
      const expectedCommandToken = isCommandTool ? getRepoSearchCommandTokenForToolName(normalizedToolName) : null;
      const actualCommandToken = isCommandTool ? getFirstCommandToken(command) : null;
      if (isCommandTool && (!expectedCommandToken || actualCommandToken !== expectedCommandToken)) {
        invalidResponses += 1;
        const invalidToolCommandMessage = `Invalid action: ${normalizedToolName} only allows commands starting with '${expectedCommandToken || '<unknown>'}'.`;
        batchOutcomes.push({
          action: { tool_name: normalizedToolName, args: toolAction.args },
          toolCallId: `invalid_call_${invalidResponses}`,
          toolContent: invalidToolCommandMessage,
        });
        options.logger?.write({
          kind: 'turn_action_invalid',
          taskId: task.id,
          turn,
          invalidResponses,
          error: invalidToolCommandMessage,
          toolAction,
          toolResultText: invalidToolCommandMessage,
        });
        if (invalidResponses >= maxInvalidResponses) { reason = 'invalid_response_limit'; break; }
        continue;
      }
      if (inForcedFinishMode) {
        forcedFinishAttemptsRemaining = Math.max(forcedFinishAttemptsRemaining - 1, 0);
        const forcedReason = `Forced finish mode active. Return a finish action now. Attempts remaining: ${forcedFinishAttemptsRemaining}.`;
        commandFailures += 1;
        commands.push({ command, safe: false, reason: forcedReason, exitCode: null, output: `Rejected command: ${forcedReason}` });
        batchOutcomes.push({
          action: buildEffectiveTranscriptAction({
            toolName: normalizedToolName,
            rawArgs: toolAction.args,
            isNativeTool,
            commandToRun: command,
          }),
          toolCallId: `forced_finish_call_${commands.length}`,
          toolContent: `Rejected command: ${forcedReason}`,
        });
        pendingForcedFinishCountdownText = `Forced finish attempts remaining: ${forcedFinishAttemptsRemaining}. Return a finish action now.`;
        if (forcedFinishAttemptsRemaining === 0) { reason = 'forced_finish_attempt_limit'; break; }
        continue;
      }

      const normalized = isNativeTool
        ? { command, rewritten: false, note: '', rejected: false }
        : normalizePlannerCommand(command, { repoRoot: options.repoRoot, ignorePolicy });
      const fingerprint = isNativeTool
        ? fingerprintToolCall({ toolName: normalizedToolName, command })
        : normalized.rejected
          ? ''
          : fingerprintToolCall({ toolName: normalizedToolName, command: normalized.command });
      const prospectiveToolType = isNativeTool
        ? normalizedToolName
        : normalized.rejected
          ? 'loop'
          : normalizeToolTypeFromCommand(normalized.command);

      // Duplicate check on the normalized command so auto-appended flags don't confuse dedup
      const normalizedKey = isNativeTool
        ? command
        : normalized.rejected
          ? command
          : normalized.command;
    const duplicateFingerprint = fingerprint || `${normalizedToolName}|${normalizedKey}`;
    const isExactDuplicate = Boolean(lastSuccessfulNormalizedKey && normalizedKey === lastSuccessfulNormalizedKey);
    const isSemanticDuplicate = Boolean(!isExactDuplicate && !normalized.rejected && fingerprint && lastSuccessfulFingerprint && fingerprint === lastSuccessfulFingerprint);
    const canAdvanceRepeatedRead = normalizedToolName === 'repo_read_file' || Boolean(!isNativeTool && parseGetContentReadWindowCommand(normalizedKey));
    if (!canAdvanceRepeatedRead && (isExactDuplicate || isSemanticDuplicate)) {
      const isActiveDuplicate = duplicateReplayFingerprint === duplicateFingerprint
        && duplicateReplayToolMessageIndex >= 0
        && duplicateReplayToolMessageIndex < messages.length;
      duplicateReplayFingerprint = duplicateFingerprint;
      duplicateReplayCount = isActiveDuplicate ? (duplicateReplayCount + 1) : 2;
      const duplicateMessage = buildRepeatedToolCallSummary(normalizedToolName, duplicateReplayCount);
      commandFailures += 1;
      const rejectionReason = isExactDuplicate ? 'duplicate command' : 'semantic duplicate command';
      commands.push({ command, safe: false, reason: rejectionReason, exitCode: null, output: `Rejected: ${duplicateMessage}` });
      if (isActiveDuplicate) {
        const previousToolMessage = messages[duplicateReplayToolMessageIndex];
        messages[duplicateReplayToolMessageIndex] = {
          role: 'tool',
          tool_call_id: previousToolMessage?.tool_call_id,
          content: duplicateMessage,
        };
      } else {
        const duplicateToolCallId = `duplicate_call_${commands.length}`;
        batchOutcomes.push({
          action: buildEffectiveTranscriptAction({
            toolName: normalizedToolName,
            rawArgs: toolAction.args,
            isNativeTool,
            commandToRun: command,
          }),
          toolCallId: duplicateToolCallId,
          toolContent: duplicateMessage,
        });
        batchDuplicateAnchorIndex = batchOutcomes.length - 1;
      }
      if (isSemanticDuplicate) {
        const currentToolStats = toolStatsByType[prospectiveToolType] || createEmptyToolTypeStats();
        toolStatsByType[prospectiveToolType] = {
          ...currentToolStats,
          semanticRepeatRejects: currentToolStats.semanticRepeatRejects + 1,
        };
        options.logger?.write({
          kind: 'turn_semantic_repeat_rejected',
          taskId: task.id,
          turn,
          command,
          fingerprint,
          repeats: duplicateReplayCount,
        });
      }
      if (duplicateReplayCount >= DUPLICATE_FORCE_THRESHOLD && forcedFinishAttemptsRemaining === 0) {
        forcedFinishAttemptsRemaining = FORCED_FINISH_MAX_ATTEMPTS;
        pendingModeChangeUserMessages.push('Forced finish mode active. Return {"action":"finish",...} now. Tool calls are blocked.');
        toolStatsByType[prospectiveToolType] = {
          ...toolStatsByType[prospectiveToolType],
          forcedFinishFromStagnation: Number(toolStatsByType[prospectiveToolType]?.forcedFinishFromStagnation || 0) + 1,
        };
        options.logger?.write({
          kind: 'turn_forced_finish_mode_started',
          taskId: task.id,
          turn,
          attemptsRemaining: forcedFinishAttemptsRemaining,
          trigger: isSemanticDuplicate ? 'semantic_repetition' : 'consecutive_duplicates',
        });
      }
      continue;
    }
    if (isNativeTool) {
      if (normalizedToolName === 'repo_read_file') {
        const nativeReadPlan = planRepoReadFile(toolAction.args, options.repoRoot, ignorePolicy, fileReadStateByPath);
        nativeExecution = isFailedRepoReadFilePlan(nativeReadPlan)
          ? { ok: false, command: nativeReadPlan.command, reason: nativeReadPlan.reason, toolType: normalizedToolName }
          : buildRepoReadFileExecution(normalizedToolName, nativeReadPlan, null);
      } else {
        nativeExecution = executeNativeRepoTool(normalizedToolName, toolAction.args, options.repoRoot, ignorePolicy, fileReadStateByPath);
      }
    }
    if (isNativeTool && nativeExecution && !nativeExecution.ok) {
      safetyRejects += 1;
      const rejection = `Rejected command: ${nativeExecution.reason}`;
      commands.push({ command, safe: false, reason: nativeExecution.reason, exitCode: null, output: rejection });
      batchOutcomes.push({
        action: buildEffectiveTranscriptAction({
          toolName: normalizedToolName,
          rawArgs: toolAction.args,
          isNativeTool,
          commandToRun: nativeExecution.command,
        }),
        toolCallId: `rejected_call_${commands.length}`,
        toolContent: rejection,
      });
      continue;
    }
    if (!isNativeTool && normalized.rejected) {
      safetyRejects += 1;
      const rejection = `Rejected command: ${normalized.rejectedReason}`;
      commands.push({ command, safe: false, reason: normalized.rejectedReason || null, exitCode: null, output: rejection });
      batchOutcomes.push({
        action: buildEffectiveTranscriptAction({
          toolName: normalizedToolName,
          rawArgs: toolAction.args,
          isNativeTool,
          commandToRun: command,
        }),
        toolCallId: `rejected_call_${commands.length}`,
        toolContent: rejection,
      });
      continue;
    }

    const requestedCommand = isNativeTool && nativeExecution?.ok
      ? nativeExecution.requestedCommand || command
      : command;
    const normalizedCommand = isNativeTool && nativeExecution?.ok ? nativeExecution.command : isNativeTool ? command : normalized.command;
    const preExecutionDynamicPerToolRatio = Math.max(PER_TOOL_RESULT_RATIO, Number(commands.length) / Number(maxTurns));
    const preExecutionPerToolCapTokens = Math.max(1, Math.floor(usablePromptTokens * preExecutionDynamicPerToolRatio));
    const parsedReadWindow = isNativeTool ? null : parseGetContentReadWindowCommand(normalizedCommand);
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
        const previousReturnedMaxEnd = existingReadState.mergedReturnedRanges.length > 0
          ? Math.max(...existingReadState.mergedReturnedRanges.map((range) => range.end))
          : getPreviousExecutedMaxEnd(existingReadState);
        const adjustedWindow = computeAdjustedReadWindow({
          requestedStart: parsedReadWindow.requestedStart,
          requestedEnd: parsedReadWindow.requestedEnd,
          minLinesFromCap,
          roundingStep: LINE_READ_ROUNDING_STEP,
          previousExecutedMaxEnd: previousReturnedMaxEnd,
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

    const safety = isNativeTool
      ? { safe: true, reason: null }
      : evaluateCommandSafety(commandToRun, options.repoRoot);
    options.logger?.write({ kind: 'turn_command_safety', taskId: task.id, turn, command: commandToRun, safe: safety.safe, reason: safety.reason });

    if (!safety.safe) {
      safetyRejects += 1;
      const rejection = `Rejected command: ${safety.reason}`;
      commands.push({ command: commandToRun, safe: false, reason: safety.reason, exitCode: null, output: rejection });
      const rejectedModelVisibleCommand = isNativeTool || lineReadAdjustment || !normalized.rewritten
        ? commandToRun
        : requestedCommand;
      batchOutcomes.push({
        action: buildEffectiveTranscriptAction({
          toolName: normalizedToolName,
          rawArgs: toolAction.args,
          isNativeTool,
          commandToRun: rejectedModelVisibleCommand,
        }),
        toolCallId: `rejected_call_${commands.length}`,
        toolContent: rejection,
      });
      continue;
    }

    const promptTokenCount = preflight.promptTokenCount;

    if (options.onProgress) {
      options.onProgress({ kind: 'tool_start', turn, maxTurns, command: requestedCommand, promptTokenCount, elapsedMs: Date.now() - taskStartedAt });
    }

    const toolExecutionSpan = options.timingRecorder?.start('repo.tool.execute', {
      taskId: task.id,
      turn,
      toolName: normalizedToolName,
      commandChars: commandToRun.length,
      native: isNativeTool,
    });
    const executed = isNativeTool && nativeExecution && nativeExecution.ok
      ? { exitCode: nativeExecution.exitCode, output: nativeExecution.output }
      : await executeRepoCommand(commandToRun, options.repoRoot, options.mockCommandResults || null, options.abortSignal);
    toolExecutionSpan?.end({
      exitCode: executed.exitCode,
      outputChars: String(executed.output || '').length,
    });
    const baseOutput = String(executed.output || '').trim();
    const searchExit = classifySearchExit(commandToRun, Number(executed.exitCode), baseOutput);
    const promptedBaseOutput = searchExit.syntaxFailure && searchExit.message
      ? `${searchExit.message}\n${baseOutput}`.trim()
      : baseOutput;
    const executedReadWindow = isNativeTool ? null : parseGetContentReadWindowCommand(commandToRun);
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
    }
    if (lineReadAdjustment) {
      rewriteNotesForLogs.push(
        `note: repeated file read window adjusted; requested start=${lineReadAdjustment.requestedStart} end=${lineReadAdjustment.requestedEnd}; adjusted start=${lineReadAdjustment.adjustedStart} end=${lineReadAdjustment.adjustedEnd}; reason=${lineReadAdjustment.reason}; ran '${lineReadAdjustment.executedCommand}' instead`
      );
    }
    const outputWithRewriteNote = rewriteNotesForLogs.length > 0
      ? `${rewriteNotesForLogs.join('\n')}\n${promptedBaseOutput}`.trim()
      : promptedBaseOutput;
    const outputForPrompt = rewriteNotesForPrompt.length > 0
      ? `${rewriteNotesForPrompt.join('\n')}\n${promptedBaseOutput}`.trim()
      : promptedBaseOutput;

    if (Number(executed.exitCode) !== 0 && !searchExit.noMatch) {
      commandFailures += 1;
    }

    let zeroOutputWarningText = '';
    if (baseOutput.length === 0) {
      zeroOutputStreak += 1;
      const remainingBeforeForce = Math.max(ZERO_OUTPUT_FORCE_THRESHOLD - zeroOutputStreak, 0);
      zeroOutputWarningText = remainingBeforeForce > 0
        ? `Zero-output warning: ${remainingBeforeForce} more zero-output command(s) and you will be forced to answer.`
        : `Zero-output limit reached: you are now forced to answer within ${FORCED_FINISH_MAX_ATTEMPTS} attempt(s).`;
      options.logger?.write({
        kind: 'turn_zero_output_countdown', taskId: task.id, turn, zeroOutputStreak, remainingBeforeForce,
      });
      if (remainingBeforeForce === 0 && forcedFinishAttemptsRemaining === 0) {
        forcedFinishAttemptsRemaining = FORCED_FINISH_MAX_ATTEMPTS;
        pendingModeChangeUserMessages.push('Forced finish mode active. Return {"action":"finish",...} now. Tool calls are blocked.');
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
    const suppressExitCode = searchExit.noMatch && outputForPrompt.length > 0;
    const rawResultText = suppressExitCode
      ? outputForPrompt
      : `exit_code=${executed.exitCode}\n${outputForPrompt}`.trim();
    const promptVisibleCommand = isNativeTool || lineReadAdjustment || !normalized.rewritten
      ? commandToRun
      : requestedCommand;
    let resultText = buildPromptToolResult({
      toolName: normalizedToolName,
      command: isNativeTool ? commandToRun : promptVisibleCommand,
      exitCode: executed.exitCode,
      rawOutput: rawResultText,
    });
    if (zeroOutputWarningText) {
      resultText = `${zeroOutputWarningText}\n\n${resultText}`.trim();
    }
    const rawToolTokenSpan = options.timingRecorder?.start('repo.tool.tokenize_raw', {
      taskId: task.id,
      turn,
      toolName: normalizedToolName,
      inputChars: rawResultText.length,
    });
    const rawResultTokenCount = useEstimatedTokensOnly
      ? estimateTokenCount(options.config, rawResultText)
      : await countTokensWithFallback(options.config, rawResultText);
    rawToolTokenSpan?.end({ tokenCount: rawResultTokenCount });
    let lineReadStats = isNativeTool && nativeExecution && nativeExecution.ok && nativeExecution.lineReadStats
      ? nativeExecution.lineReadStats
      : getRepoSearchLineReadStats(commandToRun, baseOutput, rawResultTokenCount);
    const dynamicPerToolRatio = Math.max(PER_TOOL_RESULT_RATIO, Number(commands.length) / Number(maxTurns));
    const perToolCapTokens = Math.max(1, Math.floor(usablePromptTokens * dynamicPerToolRatio));
    const remainingTokenAllowance = Math.max(
      usablePromptTokens - promptTokenCount - acceptedToolPromptTokensThisTurn,
      0
    );
    const promptToolTokenSpan = options.timingRecorder?.start('repo.tool.tokenize_prompt', {
      taskId: task.id,
      turn,
      toolName: normalizedToolName,
      inputChars: resultText.length,
    });
    const candidateResultTokenCount = useEstimatedTokensOnly
      ? estimateTokenCount(options.config, resultText)
      : await countTokensWithFallback(options.config, resultText);
    promptToolTokenSpan?.end({ tokenCount: candidateResultTokenCount });

    let resultTokenCount = candidateResultTokenCount;
    let resultTokenCountEstimated = useEstimatedTokensOnly;
    let fittedReturnedSegmentCount: number | null = null;

    if (candidateResultTokenCount > perToolCapTokens || candidateResultTokenCount > remainingTokenAllowance) {
      const commandSucceededForFitting = Number(executed.exitCode) === 0 || searchExit.noMatch;
      if (commandSucceededForFitting) {
        const resultLinesForFitting = resultText.split(/\r?\n/u).filter((line) => line.length > 0);
        const fitHeaderText = undefined;
        const fitSegments = resultLinesForFitting;
        const fitter = new ToolOutputFitter({
          async countToolOutputTokens(text: string): Promise<number> {
            return useEstimatedTokensOnly
              ? estimateTokenCount(options.config, text)
              : await countTokensWithFallback(options.config, text);
          },
        });
        const fitResult = await fitter.fitSegments({
          headerText: fitHeaderText,
          segments: fitSegments,
          separator: '\n',
          maxTokens: Math.min(perToolCapTokens, Math.max(1, remainingTokenAllowance)),
          unit: nativeExecution && nativeExecution.ok && nativeExecution.outputUnit
            ? nativeExecution.outputUnit
            : 'lines',
        });
        fittedReturnedSegmentCount = fitResult.returnedLineCount;
        resultText = fitResult.visibleText;
        const fitTokenSpan = options.timingRecorder?.start('repo.tool.tokenize_fit', {
          taskId: task.id,
          turn,
          toolName: normalizedToolName,
          inputChars: resultText.length,
        });
        resultTokenCount = useEstimatedTokensOnly
          ? estimateTokenCount(options.config, resultText)
          : await countTokensWithFallback(options.config, resultText);
        fitTokenSpan?.end({ tokenCount: resultTokenCount });
        resultTokenCountEstimated = useEstimatedTokensOnly;
      } else {
        resultText = `Error: requested output would consume ${candidateResultTokenCount} tokens, remaining token allowance: ${remainingTokenAllowance}, per tool call allowance: ${perToolCapTokens}`;
        writeRedConsoleLine(`repo_search warning: ${resultText}`);

        if (useEstimatedTokensOnly) {
          resultTokenCount = estimateTokenCount(options.config, resultText);
          resultTokenCountEstimated = true;
        } else {
          const rejectionToolTokenSpan = options.timingRecorder?.start('repo.tool.tokenize_rejection', {
            taskId: task.id,
            turn,
            toolName: normalizedToolName,
            inputChars: resultText.length,
          });
          resultTokenCount = await countTokensWithFallback(options.config, resultText);
          rejectionToolTokenSpan?.end({ tokenCount: resultTokenCount });
          resultTokenCountEstimated = false;
        }
      }
    }
    if (nativeExecution && nativeExecution.ok && nativeExecution.readFile && nativeExecution.lineReadStats && nativeExecution.lineReadStats.lineReadLinesTotal > 0) {
      const fileReadState = getOrCreateFileReadState(fileReadStateByPath, nativeExecution.readFile.pathKey);
      const returnedLineCount = Math.min(
        nativeExecution.lineReadStats.lineReadLinesTotal,
        fittedReturnedSegmentCount ?? resultText.split(/\r?\n/u).filter((line) => /^\d+:/u.test(line)).length,
      );
      if (returnedLineCount > 0) {
        const returnedEndLineExclusive = nativeExecution.readFile.startLine + returnedLineCount;
        commandToRun = buildRepoReadFileCommand(
          nativeExecution.readFile.commandPath,
          nativeExecution.readFile.startLine,
          returnedEndLineExclusive - 1,
        );
        lineReadStats = {
          lineReadCalls: 1,
          lineReadLinesTotal: returnedLineCount,
          lineReadTokensTotal: Math.max(1, estimateTokenCount(options.config, resultText)),
        };
        fileReadState.mergedReturnedRanges = mergeRange(fileReadState.mergedReturnedRanges, {
          start: nativeExecution.readFile.startLine,
          end: returnedEndLineExclusive,
        });
      }
    }
    if (!isNativeTool && parsedReadWindow && executedReadWindow && executedReadWindow.pathKey === parsedReadWindow.pathKey) {
      const fileReadState = getOrCreateFileReadState(fileReadStateByPath, parsedReadWindow.pathKey);
      const returnedLineCount = Math.min(
        Math.max(0, executedReadWindow.requestedEnd - executedReadWindow.requestedStart),
        fittedReturnedSegmentCount ?? Math.max(0, executedReadWindow.requestedEnd - executedReadWindow.requestedStart),
      );
      const executedLineCount = Math.max(0, executedReadWindow.requestedEnd - executedReadWindow.requestedStart);
      if (fittedReturnedSegmentCount !== null && returnedLineCount < executedLineCount) {
        const adjustedNewLinesCovered = Math.min(lineReadNewLinesCovered, returnedLineCount);
        fileReadState.totalLinesRead += returnedLineCount - executedLineCount;
        fileReadState.uniqueLinesRead += adjustedNewLinesCovered - lineReadNewLinesCovered;
        lineReadNewLinesCovered = adjustedNewLinesCovered;
        lineReadCumulativeUniqueLines = fileReadState.uniqueLinesRead;
      }
      if (returnedLineCount > 0) {
        fileReadState.mergedReturnedRanges = mergeRange(fileReadState.mergedReturnedRanges, {
          start: executedReadWindow.requestedStart,
          end: executedReadWindow.requestedStart + returnedLineCount,
        });
      }
    }
    const toolType = isNativeTool
      ? normalizedToolName
      : normalizeToolTypeFromCommand(commandToRun);
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

    const modelVisibleCommand = isNativeTool || lineReadAdjustment || !normalized.rewritten
      ? commandToRun
      : requestedCommand;
    const commandOutputText = isNativeTool && nativeExecution?.ok ? resultText : outputWithRewriteNote;

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
      exitCode: executed.exitCode, output: commandOutputText,
      promptTokenCount, resultTokenCount, perToolCapTokens, remainingTokenAllowance,
      insertedResultText: resultText,
    });

    commands.push({ command: commandToRun, safe: true, reason: null, exitCode: executed.exitCode, output: commandOutputText });
    const commandSucceeded = Number(executed.exitCode) === 0 || searchExit.noMatch;
    if (commandSucceeded) {
      duplicateReplayFingerprint = null;
      duplicateReplayCount = 0;
      duplicateReplayToolMessageIndex = -1;
      lastSuccessfulNormalizedKey = normalizedKey;
      lastSuccessfulFingerprint = fingerprint || null;
    }
    const toolCallId = `call_${commands.length}`;
    batchOutcomes.push({
      action: buildEffectiveTranscriptAction({
        toolName: normalizedToolName,
        rawArgs: toolAction.args,
        isNativeTool,
        commandToRun: modelVisibleCommand,
      }),
      toolCallId,
      toolContent: resultText,
    });
    acceptedToolPromptTokensThisTurn += Math.max(0, Math.ceil(resultTokenCount));
    }

    const preAppendMessagesLength = messages.length;
    const appendSpan = options.timingRecorder?.start('repo.tool.append', {
      taskId: task.id,
      turn,
      outcomeCount: batchOutcomes.length,
      beforeMessageCount: messages.length,
    });
    appendToolBatchExchange(
      messages as unknown as ToolTranscriptMessage[],
      batchOutcomes,
      String(response.thinkingText || '').trim(),
    );
    appendSpan?.end({ afterMessageCount: messages.length });
    if (batchDuplicateAnchorIndex !== null && batchOutcomes.length > 0) {
      duplicateReplayToolMessageIndex = preAppendMessagesLength + 1 + batchDuplicateAnchorIndex;
    }
    for (const userMessage of pendingModeChangeUserMessages) {
      messages.push({ role: 'user', content: userMessage });
    }
    if (pendingForcedFinishCountdownText !== null) {
      forcedFinishCountdownUserMessageIndex = upsertTrailingUserMessage(
        messages as unknown as ToolTranscriptMessage[],
        forcedFinishCountdownUserMessageIndex,
        pendingForcedFinishCountdownText,
      );
    }
    if (reason === 'forced_finish_attempt_limit') {
      break;
    }
  }

  // Terminal synthesis if no final output — retry up to 3 times then hard-fail.
  if (!String(finalOutput || '').trim()) {
    const synthesisPrompt = buildTerminalSynthesisPrompt({
      question: task.question,
      reason,
      transcript: renderTaskTranscript(messages.slice(2)),
    });
    const synthesisPromptTokenCount = await countTokensWithFallback(
      useEstimatedTokensOnly ? undefined : options.config,
      synthesisPrompt,
    );
    const synthesisMaxTokens = getDynamicMaxOutputTokens({
      totalContextTokens,
      promptTokenCount: synthesisPromptTokenCount,
    });
    options.logger?.write({
      kind: 'task_terminal_synthesis_requested',
      taskId: task.id,
      reason,
      promptTokenCount: synthesisPromptTokenCount,
      maxOutputTokens: synthesisMaxTokens,
    });
    const maxSynthesisAttempts = 3;
    let lastErrorMessage = '';
    let successAttempt = 0;
    for (let attempt = 1; attempt <= maxSynthesisAttempts; attempt += 1) {
      try {
        const synthesisResponse = await requestTerminalSynthesis({
          baseUrl: options.baseUrl,
          model: options.model,
          prompt: synthesisPrompt,
          timeoutMs: options.timeoutMs || DEFAULT_TIMEOUT_MS,
          mockResponses: options.mockResponses,
          mockResponseIndex,
          maxTokens: synthesisMaxTokens,
          thinkingEnabled: plannerThinkingEnabled,
          reasoningContentEnabled: plannerReasoningContentEnabled,
          preserveThinking: plannerPreserveThinkingEnabled,
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
        if (Number.isFinite(synthesisResponse.promptEvalDurationMs) && Number(synthesisResponse.promptEvalDurationMs) >= 0) modelPromptEvalDurationMs += Number(synthesisResponse.promptEvalDurationMs);
        if (Number.isFinite(synthesisResponse.generationDurationMs) && Number(synthesisResponse.generationDurationMs) >= 0) modelGenerationDurationMs += Number(synthesisResponse.generationDurationMs);

        const text = String(synthesisResponse.text || '').trim();
        if (!synthesisResponse.mockExhausted && text) {
          finalOutput = text;
          successAttempt = attempt;
          break;
        }
        lastErrorMessage = synthesisResponse.mockExhausted ? 'mock_exhausted' : 'empty_output';
        options.logger?.write({ kind: 'task_terminal_synthesis_retry', taskId: task.id, attempt, error: lastErrorMessage });
      } catch (error) {
        lastErrorMessage = error instanceof Error ? error.message : String(error);
        options.logger?.write({ kind: 'task_terminal_synthesis_retry', taskId: task.id, attempt, error: lastErrorMessage });
      }
    }
    if (!String(finalOutput || '').trim()) {
      options.logger?.write({ kind: 'task_terminal_synthesis_failed', taskId: task.id, reason, lastError: lastErrorMessage });
      throw new Error(`Terminal synthesis produced no usable output after ${maxSynthesisAttempts} attempts (reason=${reason}, last=${lastErrorMessage || 'unknown'}).`);
    }
    options.logger?.write({ kind: 'task_terminal_synthesis_result', taskId: task.id, attempt: successAttempt, finalOutput });
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
    promptEvalDurationMs: modelPromptEvalDurationMs,
    generationDurationMs: modelGenerationDurationMs,
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
    promptEvalDurationMs: options.tasks.reduce((s, t) => s + Number(t.promptEvalDurationMs || 0), 0),
    generationDurationMs: options.tasks.reduce((s, t) => s + Number(t.generationDurationMs || 0), 0),
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
  maxTurns?: number;
  timeoutMs?: number;
  maxInvalidResponses?: number;
  minToolCallsBeforeFinish?: number;
  taskPrompt?: string;
  availableModels?: string[];
  mockResponses?: string[];
  mockCommandResults?: Record<string, RepoSearchMockCommandResult>;
  abortSignal?: AbortSignal;
  logger?: JsonLogger | null;
  onProgress?: ((event: RepoSearchProgressEvent) => void) | null;
  timingRecorder?: TemporaryTimingRecorder | null;
} = {}): Promise<Scorecard> {
  throwIfAborted(options.abortSignal);
  const plannerToolDefinitions = resolveRepoSearchPlannerToolDefinitions(options.allowedTools);
  if (plannerToolDefinitions.length === 0) {
    throw new Error('No repo-search planner tools are enabled for the active preset.');
  }
  const path = await import('node:path');
  const repoRoot = path.resolve(options.repoRoot || process.cwd());
  const configSpan = options.timingRecorder?.start('repo.config.load', {
    provided: Boolean(options.config),
  });
  const config = (options.config || await loadConfig({ ensure: true })) as SiftConfig;
  configSpan?.end();
  const model = options.model || getConfiguredModel(config);
  const baseUrl = options.baseUrl || getConfiguredLlamaBaseUrl(config);

  options.logger?.write({ kind: 'run_start', repoRoot, requestedModel: options.model || null, configuredModel: model, baseUrl });

  const inventorySpan = options.timingRecorder?.start('repo.model_inventory', {
    mock: Array.isArray(options.mockResponses),
  });
  options.onProgress?.({ kind: 'model_inventory_start', elapsedMs: 0 });
  const availableModels = options.availableModels
    || (Array.isArray(options.mockResponses) ? [model] : await listLlamaCppModels(config));
  inventorySpan?.end({ modelCount: availableModels.length });
  options.onProgress?.({ kind: 'model_inventory_done', modelCount: availableModels.length, elapsedMs: 0 });
  options.logger?.write({ kind: 'model_inventory', configuredModel: model, availableModels });

  const tasksToRun: TaskDefinition[] = options.taskPrompt
    ? [{ id: 'repo-search', question: String(options.taskPrompt), signals: [] }]
    : TASK_PACK;

  const tasks: TaskResult[] = [];

  for (const task of tasksToRun) {
    throwIfAborted(options.abortSignal);
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
      plannerToolDefinitions,
      includeAgentsMd: options.includeAgentsMd,
      includeRepoFileListing: options.includeRepoFileListing,
      mockResponses: options.mockResponses,
      mockCommandResults: options.mockCommandResults,
      abortSignal: options.abortSignal,
      logger: options.logger || null,
      onProgress: options.onProgress || null,
      timingRecorder: options.timingRecorder || null,
    });
    tasks.push(result);
  }

  const scorecard = buildScorecard({ runId: randomUUID(), model, tasks });
  options.logger?.write({ kind: 'run_done', scorecard });
  return scorecard;
}

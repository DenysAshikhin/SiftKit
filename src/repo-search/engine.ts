import { randomUUID } from 'node:crypto';
import {
  applyHostLlamaRuntimeSettings,
  getConfiguredLlamaBaseUrl,
  getConfiguredLlamaNumCtx,
  getConfiguredModel,
  loadConfig,
  type SiftConfig,
} from '../config/index.js';
import { mergeToolTypeStats } from '../line-read-guidance.js';
import { z } from '../lib/zod.js';
import type { TemporaryTimingRecorder } from '../lib/temporary-timing-recorder.js';
import { listLlamaCppModels } from '../providers/llama-cpp.js';
import { ToolTypeStatsSchema, type ToolTypeStats } from '../status-server/metrics.js';
import { throwIfAborted } from '../lib/abort.js';
import {
  mergeReadOverlapSummaries,
  ReadOverlapSummarySchema,
} from './engine/read-overlap.js';
import { TaskResultSchema } from './engine/task-loop-support.js';
import {
  DEFAULT_MAX_INVALID_RESPONSES,
  DEFAULT_MAX_TURNS,
  DEFAULT_TIMEOUT_MS,
  type RunTaskLoopOptions,
  TaskLoop,
  type TaskDefinition,
  type TaskResult,
} from './engine/task-loop.js';
import {
  resolveRepoSearchPlannerToolDefinitions,
  type ChatMessage,
} from './planner-protocol.js';
import type {
  JsonLogger,
  RetainedWebToolCall,
  RepoSearchMockCommandResult,
  RepoSearchProgressEvent,
} from './types.js';

export { evaluateTaskSignals, type RunTaskLoopOptions, type TaskDefinition, type TaskResult } from './engine/task-loop.js';

// ---------------------------------------------------------------------------
// Task definitions (built-in self-test pack)
// ---------------------------------------------------------------------------

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
// Main task loop
// ---------------------------------------------------------------------------

export async function runTaskLoop(task: TaskDefinition, options: RunTaskLoopOptions): Promise<TaskResult> {
  return new TaskLoop(task, options).run();
}

// ---------------------------------------------------------------------------
// Scorecard
// ---------------------------------------------------------------------------

export const ScorecardSchema = z.object({
  runId: z.string(),
  model: z.string(),
  tasks: z.array(TaskResultSchema),
  totals: z.record(z.string(), z.number()),
  toolStats: z.record(z.string(), ToolTypeStatsSchema),
  readOverlapSummary: ReadOverlapSummarySchema,
  verdict: z.enum(['pass', 'fail']),
  failureReasons: z.array(z.string()),
});
export type Scorecard = z.infer<typeof ScorecardSchema>;

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
    outputTokensEstimatedCount: options.tasks.reduce((s, t) => s + Number(t.outputTokensEstimatedCount || 0), 0),
    thinkingTokensEstimatedCount: options.tasks.reduce((s, t) => s + Number(t.thinkingTokensEstimatedCount || 0), 0),
    promptCacheTokens: options.tasks.reduce((s, t) => s + Number(t.promptCacheTokens || 0), 0),
    promptEvalTokens: options.tasks.reduce((s, t) => s + Number(t.promptEvalTokens || 0), 0),
    promptEvalDurationMs: options.tasks.reduce((s, t) => s + Number(t.promptEvalDurationMs || 0), 0),
    generationDurationMs: options.tasks.reduce((s, t) => s + Number(t.generationDurationMs || 0), 0),
    speculativeAcceptedTokens: options.tasks.reduce((s, t) => s + Number(t.speculativeAcceptedTokens || 0), 0),
    speculativeGeneratedTokens: options.tasks.reduce((s, t) => s + Number(t.speculativeGeneratedTokens || 0), 0),
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
  config?: SiftConfig;
  model?: string;
  baseUrl?: string;
  allowedTools?: string[];
  includeAgentsMd?: boolean;
  includeRepoFileListing?: boolean;
  maxTurns?: number;
  timeoutMs?: number;
  maxInvalidResponses?: number;
  minToolCallsBeforeFinish?: number;
  loopKind?: 'repo-search' | 'chat';
  allowEmptyTools?: boolean;
  streamFinishAsAnswer?: boolean;
  systemPromptOverride?: string;
  historyMessages?: ChatMessage[];
  thinkingEnabledOverride?: boolean;
  taskPrompt?: string;
  availableModels?: string[];
  mockResponses?: string[];
  mockCommandResults?: Record<string, RepoSearchMockCommandResult>;
  retainedWebToolCalls?: RetainedWebToolCall[];
  abortSignal?: AbortSignal;
  logger?: JsonLogger | null;
  onProgress?: ((event: RepoSearchProgressEvent) => void) | null;
  timingRecorder?: TemporaryTimingRecorder | null;
} = {}): Promise<Scorecard> {
  throwIfAborted(options.abortSignal);
  const plannerToolDefinitions = resolveRepoSearchPlannerToolDefinitions(options.allowedTools);
  if (plannerToolDefinitions.length === 0 && !options.allowEmptyTools) {
    throw new Error('No repo-search planner tools are enabled for the active preset.');
  }
  const path = await import('node:path');
  const repoRoot = path.resolve(options.repoRoot || process.cwd());
  const configSpan = options.timingRecorder?.start('repo.config.load', {
    provided: Boolean(options.config),
  });
  // In pass-through mode the prompt-budget math must use the host SiftKit's
  // real context window, not this client's (possibly stale) local NumCtx.
  const config = await applyHostLlamaRuntimeSettings(
    options.config || await loadConfig({ ensure: true }),
  );
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
      loopKind: options.loopKind,
      streamFinishAsAnswer: options.streamFinishAsAnswer,
      systemPromptOverride: options.systemPromptOverride,
      historyMessages: options.historyMessages,
      thinkingEnabledOverride: options.thinkingEnabledOverride,
      plannerToolDefinitions,
      includeAgentsMd: options.includeAgentsMd,
      includeRepoFileListing: options.includeRepoFileListing,
      mockResponses: options.mockResponses,
      mockCommandResults: options.mockCommandResults,
      retainedWebToolCalls: options.retainedWebToolCalls,
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

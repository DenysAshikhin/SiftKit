import { randomUUID } from 'node:crypto';
import {
  applyHostLlamaRuntimeSettings,
  applyModelOverrideToConfig,
  getConfiguredLlamaBaseUrl,
  getConfiguredLlamaNumCtx,
  getConfiguredModel,
  getActiveModelPreset,
  loadConfig,
  type SiftConfig,
} from '../config/index.js';
import { mergeToolTypeStats } from '../line-read-guidance.js';
import { z } from '../lib/zod.js';
import type { TemporaryTimingRecorder } from '../lib/temporary-timing-recorder.js';
import { listLlamaCppModels } from '../providers/llama-cpp.js';
import { ToolTypeStatsSchema, type ToolTypeStats } from '../status-server/metrics.js';
import { throwIfAborted } from '../lib/abort.js';
import { SilentProgressWriter, type ProgressWriter } from '../lib/progress-writer.js';
import {
  mergeReadOverlapSummaries,
  ReadOverlapSummarySchema,
} from './engine/read-overlap.js';
import { TaskResultSchema, type ContextOverflowPolicy } from './engine/task-loop-support.js';
import type { ApprovalGate, ApprovalMode } from './engine/approval-gate.js';
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
import type { PresetSystemContext } from '../preset-system-context.js';

export { evaluateTaskSignals, type RunTaskLoopOptions, type TaskDefinition, type TaskResult } from './engine/task-loop.js';

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
  repoRoot: string;
  systemContext: PresetSystemContext;
  config?: SiftConfig;
  model?: string;
  baseUrl?: string;
  allowedTools?: string[];
  maxTurns?: number;
  timeoutMs?: number;
  maxInvalidResponses?: number;
  minToolCallsBeforeFinish?: number;
  contextOverflowPolicy?: ContextOverflowPolicy;
  validationCommandOutputLineLimit?: number | null;
  loopKind?: 'repo-search' | 'chat' | 'repo-agent';
  allowEmptyTools?: boolean;
  streamFinishAsAnswer?: boolean;
  systemPromptOverride?: string;
  historyMessages?: ChatMessage[];
  thinkingEnabledOverride?: boolean;
  taskPrompt: string | undefined;
  availableModels?: string[];
  mockResponses?: string[];
  mockCommandResults?: Record<string, RepoSearchMockCommandResult>;
  retainedWebToolCalls?: RetainedWebToolCall[];
  abortSignal?: AbortSignal;
  initialUserImages?: readonly string[];
  logger?: JsonLogger | null;
  progressWriter?: ProgressWriter<RepoSearchProgressEvent>;
  approvalGate?: ApprovalGate;
  approvalMode?: ApprovalMode;
  timingRecorder?: TemporaryTimingRecorder | null;
}): Promise<Scorecard> {
  throwIfAborted(options.abortSignal);
  if (options.taskPrompt === undefined) {
    throw new Error('runRepoSearch taskPrompt is required.');
  }
  const progressWriter = options.progressWriter ?? new SilentProgressWriter<RepoSearchProgressEvent>();
  const path = await import('node:path');
  const repoRoot = path.resolve(options.repoRoot || process.cwd());
  const configSpan = options.timingRecorder?.start('repo.config.load', {
    provided: Boolean(options.config),
  });
  // In pass-through mode the prompt-budget math must use the host SiftKit's
  // real context window, not this client's (possibly stale) local NumCtx.
  const config = applyModelOverrideToConfig(
    await applyHostLlamaRuntimeSettings(options.config || await loadConfig({ ensure: true })),
    options.model,
  );
  configSpan?.end();
  const plannerToolDefinitions = resolveRepoSearchPlannerToolDefinitions(
    options.allowedTools,
    getActiveModelPreset(config).VisionEnabled === true,
  );
  if (plannerToolDefinitions.length === 0 && !options.allowEmptyTools) {
    throw new Error('No repo-search planner tools are enabled for the active preset.');
  }
  const model = getConfiguredModel(config);
  const baseUrl = options.baseUrl || getConfiguredLlamaBaseUrl(config);

  options.logger?.write({ kind: 'run_start', repoRoot, requestedModel: options.model || null, configuredModel: model, baseUrl });

  const inventorySpan = options.timingRecorder?.start('repo.model_inventory', {
    mock: Array.isArray(options.mockResponses),
  });
  progressWriter.write({ kind: 'model_inventory_start', elapsedMs: 0 });
  const availableModels = options.availableModels
    || (Array.isArray(options.mockResponses) ? [model] : await listLlamaCppModels(config));
  inventorySpan?.end({ modelCount: availableModels.length });
  progressWriter.write({ kind: 'model_inventory_done', modelCount: availableModels.length, elapsedMs: 0 });
  options.logger?.write({ kind: 'model_inventory', configuredModel: model, availableModels });

  const tasksToRun: TaskDefinition[] = [{
    id: 'repo-search',
    question: options.taskPrompt,
    signals: [],
  }];

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
      contextOverflowPolicy: options.contextOverflowPolicy ?? 'compact',
      validationCommandOutputLineLimit:
        options.validationCommandOutputLineLimit ?? null,
      loopKind: options.loopKind,
      streamFinishAsAnswer: options.streamFinishAsAnswer,
      systemPromptOverride: options.systemPromptOverride,
      historyMessages: options.historyMessages,
      thinkingEnabledOverride: options.thinkingEnabledOverride,
      plannerToolDefinitions,
      systemContext: options.systemContext,
      mockResponses: options.mockResponses,
      mockCommandResults: options.mockCommandResults,
      retainedWebToolCalls: options.retainedWebToolCalls,
      initialUserImages: options.initialUserImages,
      abortSignal: options.abortSignal,
      logger: options.logger || null,
      progressWriter,
      approvalGate: options.approvalGate,
      approvalMode: options.approvalMode,
      timingRecorder: options.timingRecorder || null,
    });
    tasks.push(result);
  }

  const scorecard = buildScorecard({ runId: randomUUID(), model, tasks });
  options.logger?.write({ kind: 'run_done', scorecard });
  return scorecard;
}

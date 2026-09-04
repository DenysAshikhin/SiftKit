import { randomUUID } from 'node:crypto';
import {
  applyHostEngineRuntimeSettings,
  applyModelOverrideToConfig,
  getConfiguredEngineBaseUrl,
  getConfiguredEngineNumCtx,
  getConfiguredModel,
  loadConfig,
  type SiftConfig,
} from '../config/index.js';
import { mergeToolTypeStats } from '../line-read-guidance.js';
import { z } from '../lib/zod.js';
import type { TemporaryTimingRecorder } from '../lib/temporary-timing-recorder.js';
import { listInferenceModels } from '../providers/inference.js';
import { ToolTypeStatsSchema, type ToolTypeStats } from '../status-server/metrics.js';
import { throwIfAborted } from '../lib/abort.js';
import { SilentProgressWriter, type ProgressWriter } from '../lib/progress-writer.js';
import {
  mergeReadOverlapSummaries,
  ReadOverlapSummarySchema,
} from './engine/read-overlap.js';
import { TaskResultSchema, taskPassed } from './engine/task-loop-support.js';
import type { TurnTokenRecord } from './engine/turn-token-record.js';
import type { ApprovalGate } from './engine/approval-gate.js';
import {
  DEFAULT_MAX_INVALID_RESPONSES,
  DEFAULT_MAX_TURNS,
  DEFAULT_TIMEOUT_MS,
  type RunTaskLoopOptions,
  TaskLoop,
  type TaskDefinition,
  type TaskResult,
} from './engine/task-loop.js';
import type { ChatMessage } from './planner-protocol.js';
import type { PlannerToolDefinition } from '../planner-protocol/json-schema.js';
import type { MockPlannerResponseInput } from '../planner-protocol/mock-response.js';
import type {
  JsonLogger,
  RetainedWebToolCall,
  RepoSearchMockCommandResult,
  RepoSearchProgressEvent,
} from './types.js';
import type { PresetSystemContext } from '../preset-system-context.js';
import type { RepoSearchTaskKind } from './task-kind.js';
import { RepoSearchRuntimeProfile } from './engine/runtime-profile.js';

export { type RunTaskLoopOptions, type TaskDefinition, type TaskResult } from './engine/task-loop.js';

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
    passed: options.tasks.filter((t) => taskPassed(t)).length,
    failed: options.tasks.filter((t) => !taskPassed(t)).length,
    commandsExecuted: options.tasks.reduce((s, t) => s + t.commands.length, 0),
    safetyRejects: options.tasks.reduce((s, t) => s + t.safetyRejects, 0),
    invalidResponses: options.tasks.reduce((s, t) => s + t.invalidResponses, 0),
    rejectedCalls: options.tasks.reduce((s, t) => s + Number(t.rejectedCalls || 0), 0),
    nonZeroExits: options.tasks.reduce((s, t) => s + Number(t.nonZeroExits || 0), 0),
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
    if (!taskPassed(task)) failureReasons.push(`${task.id}: ended with reason ${task.reason}`);
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
  taskKind: RepoSearchTaskKind;
  config?: SiftConfig;
  model?: string;
  baseUrl?: string;
  plannerToolDefinitions: readonly PlannerToolDefinition[];
  maxTurns?: number;
  timeoutMs?: number;
  maxInvalidResponses?: number;
  minToolCallsBeforeFinish?: number;
  allowEmptyTools?: boolean;
  streamFinishAsAnswer?: boolean;
  systemPromptOverride?: string;
  historyMessages?: ChatMessage[];
  thinkingEnabledOverride?: boolean;
  taskPrompt: string | undefined;
  availableModels?: string[];
  mockResponses?: MockPlannerResponseInput[];
  mockCommandResults?: Record<string, RepoSearchMockCommandResult>;
  retainedWebToolCalls?: RetainedWebToolCall[];
  abortSignal?: AbortSignal;
  initialUserImages?: readonly string[];
  logger?: JsonLogger | null;
  progressWriter?: ProgressWriter<RepoSearchProgressEvent>;
  approvalGate?: ApprovalGate;
  timingRecorder?: TemporaryTimingRecorder | null;
}): Promise<{ scorecard: Scorecard; turnRecords: TurnTokenRecord[] }> {
  throwIfAborted(options.abortSignal);
  if (options.taskPrompt === undefined) {
    throw new Error('runRepoSearch taskPrompt is required.');
  }
  const runtimeProfile = new RepoSearchRuntimeProfile(options.taskKind);
  const progressWriter = options.progressWriter ?? new SilentProgressWriter<RepoSearchProgressEvent>();
  const path = await import('node:path');
  const repoRoot = path.resolve(options.repoRoot || process.cwd());
  const configSpan = options.timingRecorder?.start('repo.config.load', {
    provided: Boolean(options.config),
  });
  // In pass-through mode the prompt-budget math must use the host SiftKit's
  // real context window, not this client's (possibly stale) local NumCtx.
  const config = applyModelOverrideToConfig(
    await applyHostEngineRuntimeSettings(options.config || await loadConfig({ ensure: true })),
    options.model,
  );
  configSpan?.end();
  if (options.plannerToolDefinitions.length === 0 && !options.allowEmptyTools) {
    throw new Error('No repo-search planner tools are enabled for the active preset.');
  }
  const model = getConfiguredModel(config);
  const baseUrl = options.baseUrl || getConfiguredEngineBaseUrl(config);

  options.logger?.write({ kind: 'run_start', repoRoot, requestedModel: options.model || null, configuredModel: model, baseUrl });

  const inventorySpan = options.timingRecorder?.start('repo.model_inventory', {
    mock: Array.isArray(options.mockResponses),
  });
  progressWriter.write({ kind: 'model_inventory_start', elapsedMs: 0 });
  const availableModels = options.availableModels
    || (Array.isArray(options.mockResponses) ? [model] : await listInferenceModels(config));
  inventorySpan?.end({ modelCount: availableModels.length });
  progressWriter.write({ kind: 'model_inventory_done', modelCount: availableModels.length, elapsedMs: 0 });
  options.logger?.write({ kind: 'model_inventory', configuredModel: model, availableModels });

  const tasksToRun: TaskDefinition[] = [{
    id: 'repo-search',
    question: options.taskPrompt,
  }];

  const tasks: TaskResult[] = [];
  const turnRecords: TurnTokenRecord[] = [];

  for (const task of tasksToRun) {
    throwIfAborted(options.abortSignal);
    const loop = new TaskLoop(task, {
      repoRoot,
      model,
      baseUrl,
      config,
      totalContextTokens: getConfiguredEngineNumCtx(config),
      timeoutMs: options.timeoutMs || DEFAULT_TIMEOUT_MS,
      maxTurns: runtimeProfile.resolveMaxTurns(options.maxTurns, DEFAULT_MAX_TURNS),
      maxInvalidResponses: options.maxInvalidResponses || DEFAULT_MAX_INVALID_RESPONSES,
      minToolCallsBeforeFinish: options.minToolCallsBeforeFinish,
      runtimeProfile,
      streamFinishAsAnswer: options.streamFinishAsAnswer,
      systemPromptOverride: options.systemPromptOverride,
      historyMessages: options.historyMessages,
      thinkingEnabledOverride: options.thinkingEnabledOverride,
      plannerToolDefinitions: options.plannerToolDefinitions,
      systemContext: options.systemContext,
      mockResponses: options.mockResponses,
      mockCommandResults: options.mockCommandResults,
      retainedWebToolCalls: options.retainedWebToolCalls,
      initialUserImages: options.initialUserImages,
      abortSignal: options.abortSignal,
      logger: options.logger || null,
      progressWriter,
      approvalGate: options.approvalGate,
      timingRecorder: options.timingRecorder || null,
    });
    const result = await loop.run();
    tasks.push(result);
    turnRecords.push(...loop.turnTokenRecords());
  }

  const scorecard = buildScorecard({ runId: randomUUID(), model, tasks });
  options.logger?.write({ kind: 'run_done', scorecard });
  return { scorecard, turnRecords };
}

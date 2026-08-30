import { getActiveModelPreset, type SiftConfig } from '../../config/index.js';
import { z } from '../../lib/zod.js';
import type { TemporaryTimingRecorder } from '../../lib/temporary-timing-recorder.js';
import type { PresetSystemContext } from '../../preset-system-context.js';
import { ToolTypeStatsSchema } from '../../status-server/metrics.js';
import { type ChatMessage, type PlannerThinkingFlags } from '../planner-protocol.js';
import type { PlannerToolDefinition } from '../../planner-protocol/json-schema.js';
import type { MockPlannerResponseInput } from '../../planner-protocol/mock-response.js';
import { ReadOverlapSummarySchema } from './read-overlap.js';
import { TaskCommandSchema } from '../prompts.js';
import { ChatGroundingStatusSchema } from '../chat-grounding-policy.js';
import type {
  JsonLogger,
  RetainedWebToolCall,
  RepoSearchMockCommandResult,
  RepoSearchProgressEvent,
} from '../types.js';
import { detectRecentTokenRepetition, type TokenRepetitionDetection } from '../repetition-guard.js';
import { WebResearchTools } from '../../web-search/web-research-tools.js';
import type { WebSearchConfig } from '../../web-search/types.js';
import type { ProgressWriter } from '../../lib/progress-writer.js';
import type { ApprovalGate, ApprovalMode } from './approval-gate.js';
import type { RepoSearchRuntimeProfile } from './runtime-profile.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const DEFAULT_MAX_INVALID_RESPONSES = 3;
export const DEFAULT_TIMEOUT_MS = 120_000;
export const MIN_TOOL_CALLS_BEFORE_FINISH = 5;

const TOOL_BUDGET_PERCENT_NOTICES = [25, 50, 75] as const;
const TOOL_BUDGET_COUNTDOWN_WINDOW = 9;

/** The one sentence shared by the rejection error and the in-band notice, so the model never sees two disagreeing limit messages. */
export function buildToolLimitReachedSummary(executedBatches: number, toolCallLimit: number): string {
  return `Tool-call limit reached (${executedBatches}/${toolCallLimit} batches used).`;
}

/**
 * Turns reserved after the tool budget is exhausted so the model can still deliver its final
 * answer. Deliberately its own constant: it is not the forced-finish retry budget, and retuning
 * one must not silently retune the other.
 */
export const POST_LIMIT_ANSWER_SLACK_TURNS = 3;

/** In-band budget notice appended to the last tool result of a batch; null when no threshold was crossed. */
export function buildToolBudgetNotice(executedBatches: number, toolCallLimit: number): string | null {
  const remaining = toolCallLimit - executedBatches;
  if (remaining <= 0) {
    return `[tool budget] ${buildToolLimitReachedSummary(executedBatches, toolCallLimit)} You must finish now: reply with your final answer as content only — any further tool call will be rejected.`;
  }
  if (remaining <= TOOL_BUDGET_COUNTDOWN_WINDOW) {
    return `[tool budget] ${remaining} tool-call batch${remaining === 1 ? '' : 'es'} remaining (${executedBatches}/${toolCallLimit} used). Prioritize verification and finishing.`;
  }
  for (const percent of TOOL_BUDGET_PERCENT_NOTICES) {
    if (executedBatches === Math.ceil((percent / 100) * toolCallLimit)) {
      return `[tool budget] ${percent}% of the tool-call budget used (${executedBatches}/${toolCallLimit} batches).`;
    }
  }
  return null;
}

const DEFAULT_ENGINE_WEB_SEARCH_CONFIG: WebSearchConfig = {
  EnabledDefault: false,
  Providers: {
    tavily: { Enabled: false, ApiKey: '' },
    firecrawl: { Enabled: false, ApiKey: '' },
  },
  ProviderOrder: ['tavily', 'firecrawl'],
  ResultCount: 5,
  FetchMaxPages: 3,
  TimeoutMs: 15000,
  FetchMaxCharacters: 12000,
};

export function buildWebToolsForTaskLoop(config?: SiftConfig): WebResearchTools {
  return new WebResearchTools(config?.WebSearch ?? DEFAULT_ENGINE_WEB_SEARCH_CONFIG);
}

function buildToolOutputRepetitionWarning(detection: TokenRepetitionDetection): string {
  return `SiftKit stopped tool output early: recent tokens repeated every ${detection.periodTokens} tokens across the last ${detection.windowTokens} tokens after ${detection.totalTokens} tokens.`;
}

export function applyToolOutputRepetitionGuard(text: string): string {
  const detection = detectRecentTokenRepetition(text);
  if (!detection) {
    return text;
  }
  return [buildToolOutputRepetitionWarning(detection), detection.truncatedText]
    .filter((part) => part.trim().length > 0)
    .join('\n')
    .trim();
}

// ---------------------------------------------------------------------------
// Slot allocation
// ---------------------------------------------------------------------------

let nextLlamaCppSlotId = 0;

export function allocateLlamaCppSlotId(config: SiftConfig): number {
  const configuredSlots = getActiveModelPreset(config).ParallelSlots;
  const slotCount = Math.max(1, Math.floor(Number(configuredSlots) || 1));
  const slotId = nextLlamaCppSlotId % slotCount;
  nextLlamaCppSlotId = (nextLlamaCppSlotId + 1) % slotCount;
  return slotId;
}

// ---------------------------------------------------------------------------
// Task definitions
// ---------------------------------------------------------------------------

export type TaskDefinition = {
  id: string;
  question: string;
};

// ---------------------------------------------------------------------------
// Task result type
// ---------------------------------------------------------------------------

/**
 * Every way a task loop can stop. Only `finish` is a genuine completion — the rest are aborts, and
 * the scorecard must not report them as passes. Closed so a new stop condition fails to compile
 * rather than silently scoring as a pass.
 */
export const TASK_END_REASONS = [
  'finish',
  'max_turns',
  'invalid_response_limit',
  'forced_finish_attempt_limit',
  'mock_responses_exhausted',
] as const;
export const TaskEndReasonSchema = z.enum(TASK_END_REASONS);
export type TaskEndReason = z.infer<typeof TaskEndReasonSchema>;

export const TaskResultSchema = z.object({
  id: z.string(),
  question: z.string(),
  reason: TaskEndReasonSchema,
  turnsUsed: z.number(),
  safetyRejects: z.number(),
  invalidResponses: z.number(),
  /** Tool calls refused before execution: forced-finish budget, duplicate call, duplicate web tool. */
  rejectedCalls: z.number(),
  /** Commands that actually ran and returned a non-zero exit code. */
  nonZeroExits: z.number(),
  /** Verification-gate challenges issued before this task's finish was accepted. */
  finishChallenges: z.number(),
  commands: z.array(TaskCommandSchema),
  turnThinking: z.record(z.coerce.number(), z.string()),
  finalOutput: z.string(),
  /** Raw summary text from the run's last compaction; empty when the run never compacted. */
  compactionSummary: z.string(),
  /**
   * Repository-relative paths this task actually wrote to. Recorded independently of the final
   * output so a run that ends without acknowledging its own edits still reports them.
   */
  mutatedPaths: z.array(z.string()),
  groundingStatus: ChatGroundingStatusSchema.optional(),
  promptTokens: z.number(),
  outputTokens: z.number(),
  toolTokens: z.number(),
  thinkingTokens: z.number(),
  outputTokensEstimatedCount: z.number(),
  thinkingTokensEstimatedCount: z.number(),
  promptCacheTokens: z.number(),
  promptEvalTokens: z.number(),
  promptEvalDurationMs: z.number(),
  generationDurationMs: z.number(),
  speculativeAcceptedTokens: z.number(),
  speculativeGeneratedTokens: z.number(),
  toolStats: z.record(z.string(), ToolTypeStatsSchema),
  readOverlapSummary: ReadOverlapSummarySchema,
});
export type TaskResult = z.infer<typeof TaskResultSchema>;

/**
 * A task passed iff it ended by finishing. A run that stopped on a turn, invalid-response or
 * forced-finish limit did not answer the question; scoring it as a pass is how run 100b487d
 * reported verdict=pass while its own terminal synthesis said "Incomplete". Command exit codes
 * are telemetry, not verdict input: TDD red runs and recovered failures are normal work (runs
 * ac543c1c, ceeedb28 were falsely failed by the old exit-code gate).
 */
export function taskPassed(task: Pick<TaskResult, 'reason'>): boolean {
  return task.reason === 'finish';
}

// ---------------------------------------------------------------------------
// Task loop options
// ---------------------------------------------------------------------------

export type RunTaskLoopOptions = {
  repoRoot: string;
  model: string;
  baseUrl: string;
  /** The loop's single source of model, samplers and budgets — mock runs supply one too. */
  config: SiftConfig;
  totalContextTokens?: number;
  timeoutMs?: number;
  maxTurns?: number;
  maxInvalidResponses?: number;
  minToolCallsBeforeFinish?: number;
  runtimeProfile: RepoSearchRuntimeProfile;
  streamFinishAsAnswer?: boolean;
  thinkingEnabledOverride?: boolean;
  systemPromptOverride?: string;
  historyMessages?: ChatMessage[];
  initialUserImages?: readonly string[];
  plannerToolDefinitions: readonly PlannerToolDefinition[];
  systemContext: PresetSystemContext;
  mockResponses?: MockPlannerResponseInput[];
  mockCommandResults?: Record<string, RepoSearchMockCommandResult>;
  retainedWebToolCalls?: RetainedWebToolCall[];
  abortSignal?: AbortSignal;
  logger?: JsonLogger | null;
  progressWriter?: ProgressWriter<RepoSearchProgressEvent>;
  approvalGate?: ApprovalGate;
  approvalMode?: ApprovalMode;
  timingRecorder?: TemporaryTimingRecorder | null;
};

function isPlannerReasoningEnabled(config: SiftConfig): boolean {
  return getActiveModelPreset(config).Reasoning === 'on';
}

function isPlannerReasoningContentEnabled(config: SiftConfig): boolean {
  return isPlannerReasoningEnabled(config) && getActiveModelPreset(config).ReasoningContent;
}

function isPlannerPreserveThinkingEnabled(config: SiftConfig): boolean {
  return isPlannerReasoningContentEnabled(config) && getActiveModelPreset(config).PreserveThinking;
}

/** The one place the prefix-affecting rendering flags are derived from config. */
export function resolvePlannerThinkingFlags(
  config: SiftConfig,
  thinkingEnabledOverride?: boolean,
): PlannerThinkingFlags {
  const thinkingEnabled = typeof thinkingEnabledOverride === 'boolean'
    ? thinkingEnabledOverride
    : isPlannerReasoningEnabled(config);
  const reasoningContentEnabled = thinkingEnabled && isPlannerReasoningContentEnabled(config);
  return {
    thinkingEnabled,
    reasoningContentEnabled,
    preserveThinking: reasoningContentEnabled && isPlannerPreserveThinkingEnabled(config),
  };
}

export function isPlannerMaintainPerStepThinkingEnabled(config: SiftConfig): boolean {
  return isPlannerReasoningEnabled(config) && getActiveModelPreset(config).MaintainPerStepThinking;
}

export function buildAssistantReplayMessage(content: string, thinkingText: string): ChatMessage {
  return {
    role: 'assistant',
    content,
    ...(thinkingText ? { reasoning_content: thinkingText } : {}),
  };
}

// ---------------------------------------------------------------------------
// Shared loop control state
// ---------------------------------------------------------------------------

export type TurnOutcome = 'continue' | 'stop';

export type LoopCounters = {
  invalidResponses: number;
  rejectedCalls: number;
  nonZeroExits: number;
  safetyRejects: number;
  /**
   * Tool-bearing planner responses that consumed a batch-budget unit. Counted even when every
   * call in the batch was screened out (duplicate/unsafe) — a wasted response still spends budget.
   */
  executedToolBatches: number;
  reason: TaskEndReason;
};

/**
 * Why a tool call was rejected. Every rejection is logged as a `turn_command_result` with a null
 * exit code, so the event alone cannot say whether the run refused the call on a budget or screened
 * it as unsafe. Naming the kind at the emit site is what lets a consumer reproduce the engine's
 * split — `safety` tallies to `safetyRejects`, the rest to `rejectedCalls`.
 */
export const RejectionKindSchema = z.enum(['budget', 'duplicate', 'safety']);
export type RejectionKind = z.infer<typeof RejectionKindSchema>;

/**
 * An executed tool action steps the invalid-response budget back down. The guard exists to catch a
 * model wedged in a loop of malformed actions, not to punish a long run for three scattered mistakes,
 * so the count is per-streak rather than lifetime. Only an action that cleared every screen and ran
 * counts — a command that exits non-zero (a TDD red step) still decays, but an action rejected as a
 * duplicate, as unsafe, or by forced-finish mode does not.
 */
export function decayInvalidResponses(counters: LoopCounters): void {
  counters.invalidResponses = Math.max(0, counters.invalidResponses - 1);
}

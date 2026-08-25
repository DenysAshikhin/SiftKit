import { getActiveModelPreset, type SiftConfig } from '../../config/index.js';
import { ModelJson } from '../../lib/model-json.js';
import { z } from '../../lib/zod.js';
import type { TemporaryTimingRecorder } from '../../lib/temporary-timing-recorder.js';
import type { PresetSystemContext } from '../../preset-system-context.js';
import { ToolTypeStatsSchema } from '../../status-server/metrics.js';
import { resolveRepoSearchPlannerToolDefinitions, type ChatMessage, type PlannerThinkingFlags } from '../planner-protocol.js';
import type { PlannerToolDefinition } from '../../planner-protocol/json-schema.js';
import { ReadOverlapSummarySchema } from './read-overlap.js';
import { TaskCommandSchema } from '../prompts.js';
import { ChatGroundingStatusSchema } from '../chat-grounding-policy.js';
import type {
  JsonLogger,
  RetainedWebToolCall,
  RepoSearchMockCommandResult,
  RepoSearchProgressEvent,
} from '../types.js';
import type { ToolTranscriptAction } from '../../tool-call-messages.js';
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
  signals: string[];
};

export function evaluateTaskSignals(
  task: TaskDefinition,
  evidenceText: string,
): {
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
// Task result type
// ---------------------------------------------------------------------------

export const TaskResultSchema = z.object({
  id: z.string(),
  question: z.string(),
  reason: z.string(),
  turnsUsed: z.number(),
  safetyRejects: z.number(),
  invalidResponses: z.number(),
  commandFailures: z.number(),
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
  passed: z.boolean(),
  missingSignals: z.array(z.string()),
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
  mockResponses?: string[];
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

export function buildInvalidToolCallActionFromResponseText(
  responseText: string,
  allowedToolNames: readonly string[],
): ToolTranscriptAction {
  try {
    const action = ModelJson.parseRepoSearchPlannerAction(
      responseText,
      resolveRepoSearchPlannerToolDefinitions(allowedToolNames),
    );
    if (action.action === 'tool') {
      return action;
    }
    if (action.action === 'tool_batch') {
      const firstToolCall = action.calls[0];
      if (firstToolCall) {
        return {
          toolName: firstToolCall.toolName,
          args: firstToolCall.args,
        };
      }
    }
  } catch {
    // Invalid responses are fed back to the model as an explicit invalid tool call.
  }
  return {
    toolName: 'invalid_tool_call',
    args: {
      rawResponseText: String(responseText || '').trim(),
    },
  };
}

// ---------------------------------------------------------------------------
// Shared loop control state
// ---------------------------------------------------------------------------

export type TurnOutcome = 'continue' | 'stop';

export type LoopCounters = {
  invalidResponses: number;
  commandFailures: number;
  safetyRejects: number;
  reason: string;
};

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

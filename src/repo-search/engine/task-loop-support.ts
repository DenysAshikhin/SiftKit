import {
  getActiveModelPreset,
  getConfiguredLlamaSetting,
  type SiftConfig,
} from '../../config/index.js';
import { ModelJson } from '../../lib/model-json.js';
import { z } from '../../lib/zod.js';
import type { TemporaryTimingRecorder } from '../../lib/temporary-timing-recorder.js';
import { ToolTypeStatsSchema } from '../../status-server/metrics.js';
import {
  resolveRepoSearchPlannerToolDefinitions,
  type ChatMessage,
} from '../planner-protocol.js';
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
import {
  detectRecentTokenRepetition,
  type TokenRepetitionDetection,
} from '../repetition-guard.js';
import { WebResearchTools } from '../../web-search/web-research-tools.js';
import type { WebSearchConfig } from '../../web-search/types.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const DEFAULT_MAX_TURNS = 45;
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
  return [
    buildToolOutputRepetitionWarning(detection),
    detection.truncatedText,
  ].filter((part) => part.trim().length > 0).join('\n').trim();
}

// ---------------------------------------------------------------------------
// Slot allocation
// ---------------------------------------------------------------------------

let nextLlamaCppSlotId = 0;

export function allocateLlamaCppSlotId(config: SiftConfig): number {
  const configuredSlots = getConfiguredLlamaSetting(config, 'ParallelSlots');
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

export function evaluateTaskSignals(task: TaskDefinition, evidenceText: string): {
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
  commands: z.array(TaskCommandSchema),
  turnThinking: z.record(z.coerce.number(), z.string()),
  finalOutput: z.string(),
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
  config?: SiftConfig;
  totalContextTokens?: number;
  timeoutMs?: number;
  maxTurns?: number;
  maxInvalidResponses?: number;
  minToolCallsBeforeFinish?: number;
  loopKind?: 'repo-search' | 'chat';
  streamFinishAsAnswer?: boolean;
  thinkingEnabledOverride?: boolean;
  systemPromptOverride?: string;
  historyMessages?: ChatMessage[];
  plannerToolDefinitions?: ReturnType<typeof resolveRepoSearchPlannerToolDefinitions>;
  includeAgentsMd?: boolean;
  includeRepoFileListing?: boolean;
  mockResponses?: string[];
  mockCommandResults?: Record<string, RepoSearchMockCommandResult>;
  retainedWebToolCalls?: RetainedWebToolCall[];
  abortSignal?: AbortSignal;
  logger?: JsonLogger | null;
  onProgress?: ((event: RepoSearchProgressEvent) => void) | null;
  timingRecorder?: TemporaryTimingRecorder | null;
};

export function isPlannerReasoningEnabled(config: SiftConfig | undefined): boolean {
  return getConfiguredLlamaSetting(config, 'Reasoning') === 'on';
}

export function isPlannerReasoningContentEnabled(config: SiftConfig | undefined): boolean {
  return isPlannerReasoningEnabled(config)
    && (config ? getActiveModelPreset(config).ReasoningContent : false);
}

export function isPlannerPreserveThinkingEnabled(config: SiftConfig | undefined): boolean {
  return isPlannerReasoningContentEnabled(config)
    && (config ? getActiveModelPreset(config).PreserveThinking : false);
}

export function isPlannerMaintainPerStepThinkingEnabled(config: SiftConfig | undefined): boolean {
  return isPlannerReasoningEnabled(config)
    && (config ? getActiveModelPreset(config).MaintainPerStepThinking : true);
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

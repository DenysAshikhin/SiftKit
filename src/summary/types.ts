import { z } from '../lib/zod.js';
import type { RuntimeLlamaCppConfig, SiftConfig } from '../config/index.js';
import type { JsonObject } from '../lib/json-types.js';
import type { LlamaCppToolParameterSchema } from '../llm-protocol/types.js';

export const SummaryPolicyProfileSchema = z.enum([
  'general',
  'pass-fail',
  'unique-errors',
  'buried-critical',
  'json-extraction',
  'diff-summary',
  'risky-operation',
]);
export type SummaryPolicyProfile = z.infer<typeof SummaryPolicyProfileSchema>;

export type SummarySourceKind = 'standalone' | 'command-output';

export const SummaryClassificationSchema = z.enum(['summary', 'command_failure', 'unsupported_input']);
export type SummaryClassification = z.infer<typeof SummaryClassificationSchema>;

export type SummaryPhase = 'leaf' | 'merge' | 'planner';

export type SummaryTimingInput = {
  processStartedAtMs?: number | null;
  stdinWaitMs?: number | null;
  serverPreflightMs?: number | null;
};

export type SummaryRequest = {
  question: string;
  inputText: string;
  format: 'text' | 'json';
  policyProfile: SummaryPolicyProfile;
  backend?: string;
  model?: string;
  promptPrefix?: string;
  sourceKind?: SummarySourceKind;
  commandExitCode?: number | null;
  debugCommand?: string | null;
  requestTimeoutSeconds?: number;
  allowedPlannerTools?: PlannerToolName[];
  llamaCppOverrides?: Pick<RuntimeLlamaCppConfig, 'MaxTokens'>;
  timing?: SummaryTimingInput;
  statusBackendUrl?: string | null;
  config?: SiftConfig;
};

export const SummaryResultSchema = z.object({
  RequestId: z.string(),
  WasSummarized: z.boolean(),
  PolicyDecision: z.string(),
  Backend: z.string(),
  Model: z.string(),
  Summary: z.string(),
  Classification: SummaryClassificationSchema,
  RawReviewRequired: z.boolean(),
  ModelCallSucceeded: z.boolean(),
  ProviderError: z.string().nullable(),
});
export type SummaryResult = z.infer<typeof SummaryResultSchema>;

export type SummaryDecision = {
  ShouldSummarize: boolean;
  Reason: string;
  RawReviewRequired: boolean;
  CharacterCount: number;
  LineCount: number;
};

export type QuestionAnalysis = {
  IsExactDiagnosis: boolean;
  Reason: string | null;
};

export type StructuredModelDecision = {
  classification: SummaryClassification;
  rawReviewRequired: boolean;
  output: string;
};

export type PlannerToolName = 'find_text' | 'read_lines' | 'json_filter' | 'json_get';

// Planner tool parameters reuse the canonical wire schema type, so a PlannerToolDefinition
// is structurally a LlamaCppToolDefinition and forwards into the agent loop with no cast.
export type PlannerToolParameterSchema = LlamaCppToolParameterSchema;

export type PlannerToolDefinition = {
  type: 'function';
  function: {
    name: PlannerToolName;
    description: string;
    parameters: {
      type: 'object';
      properties: Record<string, PlannerToolParameterSchema>;
      required: string[];
    };
  };
};

export type PlannerPromptBudget = {
  numCtxTokens: number;
  promptReserveTokens: number;
  usablePromptBudgetTokens: number;
  plannerHeadroomTokens: number;
  plannerStopLineTokens: number;
};

export type PlannerToolCall = {
  action: 'tool';
  tool_name: PlannerToolName;
  args: JsonObject;
};

export type PlannerToolBatchAction = {
  action: 'tool_batch';
  tool_calls: Array<{
    tool_name: PlannerToolName;
    args: JsonObject;
  }>;
};

export type PlannerFinishAction = {
  action: 'finish';
  classification: SummaryClassification;
  rawReviewRequired: boolean;
  output: string;
};

export type PlannerAction = PlannerToolCall | PlannerToolBatchAction | PlannerFinishAction;

export type ChunkPromptContext = {
  isGeneratedChunk: boolean;
  mayBeTruncated: boolean;
  retryMode: 'default' | 'strict';
  chunkPath: string | null;
};

export type SummaryFailureContext = {
  requestId: string;
  promptCharacterCount?: number | null;
  promptTokenCount?: number | null;
  rawInputCharacterCount?: number | null;
  chunkInputCharacterCount?: number | null;
  chunkIndex?: number | null;
  chunkTotal?: number | null;
  chunkPath?: string | null;
  inputTokens?: number | null;
  outputCharacterCount?: number | null;
  outputTokens?: number | null;
  thinkingTokens?: number | null;
  promptCacheTokens?: number | null;
  promptEvalTokens?: number | null;
  requestDurationMs?: number | null;
  providerDurationMs?: number | null;
  wallDurationMs?: number | null;
  stdinWaitMs?: number | null;
  serverPreflightMs?: number | null;
  lockWaitMs?: number | null;
  statusRunningMs?: number | null;
  terminalStatusMs?: number | null;
};

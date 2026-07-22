import { z } from '../lib/zod.js';
import type { RuntimeLlamaCppConfig, SiftConfig } from '../config/index.js';
import type { JsonObject } from '../lib/json-types.js';
import type { LlamaCppToolParameterSchema } from '../llm-protocol/types.js';
import type { SummaryProgressEvent } from './progress-reporter.js';
import type { ProgressWriter } from '../lib/progress-writer.js';

/**
 * Summary provider identity. NOT the inference engine axis ('llama'/'exl3', see
 * getActiveInferenceBackend): 'llama.cpp' means the real, fully-capable provider
 * (chunking, planner, slots) and is what the downstream summary gates compare
 * against; 'mock' is the test double. The two axes are unrelated, so this type is
 * threaded end-to-end and an engine id is a compile error wherever it is expected.
 */
export const SummaryProviderIdSchema = z.enum(['llama.cpp', 'mock']);
export type SummaryProviderId = z.infer<typeof SummaryProviderIdSchema>;
export const DEFAULT_SUMMARY_PROVIDER: SummaryProviderId = 'llama.cpp';

export function resolveSummaryProvider(requested: SummaryProviderId | undefined): SummaryProviderId {
  return requested ?? DEFAULT_SUMMARY_PROVIDER;
}

/** IO-boundary parse: an absent provider stays absent, an unknown one fails loud. */
export function parseOptionalSummaryProvider(value: string | undefined): SummaryProviderId | undefined {
  if (value === undefined) return undefined;
  const parsed = SummaryProviderIdSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error(`Unsupported backend '${value}'; expected one of: llama.cpp, mock.`);
  }
  return parsed.data;
}

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
  backend?: SummaryProviderId;
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
  progressWriter?: ProgressWriter<SummaryProgressEvent>;
  abortSignal?: AbortSignal;
};

export const SummaryResultSchema = z.object({
  RequestId: z.string(),
  WasSummarized: z.boolean(),
  PolicyDecision: z.string(),
  Backend: SummaryProviderIdSchema,
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

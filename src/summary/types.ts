import { z } from '../lib/zod.js';
import type { SiftConfig } from '../config/index.js';
import type { SummaryProgressEvent } from './progress-reporter.js';
import type { ProgressWriter } from '../lib/progress-writer.js';
import {
  SummaryClassificationSchema,
  type SummaryClassification,
} from '../planner-protocol/summary.js';
import type { SummaryPlannerToolName } from '../planner-protocol/summary-tools.js';

/**
 * Summary provider identity. NOT the inference engine axis ('llama'/'exl3', see
 * getActiveInferenceBackend): 'real' means the real, fully-capable provider
 * (chunking, planner, slots) and is what the downstream summary gates compare
 * against; 'mock' is the test double. The two axes are unrelated, so this type is
 * threaded end-to-end and an engine id is a compile error wherever it is expected.
 */
export const SummaryProviderIdSchema = z.enum(['real', 'mock']);
export type SummaryProviderId = z.infer<typeof SummaryProviderIdSchema>;
export const DEFAULT_SUMMARY_PROVIDER: SummaryProviderId = 'real';

export function resolveSummaryProvider(requested: SummaryProviderId | undefined): SummaryProviderId {
  return requested ?? DEFAULT_SUMMARY_PROVIDER;
}

/** IO-boundary parse: an absent provider stays absent, an unknown one fails loud. */
export function parseOptionalSummaryProvider(value: string | undefined): SummaryProviderId | undefined {
  if (value === undefined) return undefined;
  const parsed = SummaryProviderIdSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error(`Unsupported provider '${value}'; expected one of: real, mock.`);
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

/**
 * Command output must finish as summary|command_failure; only standalone input
 * may classify as unsupported_input. Single source for prompt and parser policy.
 */
export function allowsUnsupportedInput(sourceKind: SummarySourceKind): boolean {
  return sourceKind !== 'command-output';
}

export type SummaryPhase = 'leaf' | 'merge' | 'planner';

export type SummaryTimingInput = {
  processStartedAtMs?: number | null;
  stdinWaitMs?: number | null;
  serverPreflightMs?: number | null;
};

export type SummaryRequest = {
  repoRoot: string;
  presetId?: string;
  question: string;
  inputText: string;
  images?: string[];
  format: 'text' | 'json';
  policyProfile: SummaryPolicyProfile;
  provider?: SummaryProviderId;
  model?: string;
  promptPrefix?: string;
  sourceKind?: SummarySourceKind;
  commandExitCode?: number | null;
  debugCommand?: string | null;
  requestTimeoutSeconds?: number;
  allowedPlannerTools?: SummaryPlannerToolName[];
  llamaCppMaxTokens?: number;
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
  Provider: SummaryProviderIdSchema,
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

export type PlannerPromptBudget = {
  numCtxTokens: number;
  responseReserveTokens: number;
  plannerStopLineTokens: number;
};

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

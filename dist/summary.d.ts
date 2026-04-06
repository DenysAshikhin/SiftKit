import { type SiftConfig } from './config/index.js';
import { UNSUPPORTED_INPUT_MESSAGE, getDeterministicExcerpt } from './summary/measure.js';
import { buildPrompt } from './summary/prompt.js';
import { buildPlannerToolDefinitions } from './summary/planner/tools.js';
import type { ChunkPromptContext, PlannerPromptBudget, SummaryClassification, SummaryDecision, SummaryPhase, SummaryPolicyProfile, SummaryRequest, SummaryResult, SummarySourceKind } from './summary/types.js';
export type { SummaryPolicyProfile, SummarySourceKind, SummaryClassification, SummaryRequest, SummaryResult, };
export { UNSUPPORTED_INPUT_MESSAGE, getDeterministicExcerpt, buildPrompt };
export declare function getSummaryDecision(text: string, question: string | null | undefined, riskLevel: 'informational' | 'debug' | 'risky', config: SiftConfig, options?: {
    sourceKind?: SummarySourceKind;
    commandExitCode?: number | null;
}): SummaryDecision;
export declare function planTokenAwareLlamaCppChunks(options: {
    question: string;
    inputText: string;
    format: 'text' | 'json';
    policyProfile: SummaryPolicyProfile;
    rawReviewRequired: boolean;
    promptPrefix?: string;
    sourceKind: SummarySourceKind;
    commandExitCode?: number | null;
    config: SiftConfig;
    chunkThreshold: number;
    phase: SummaryPhase;
    chunkContext?: ChunkPromptContext;
}): Promise<string[] | null>;
export declare function getPlannerPromptBudget(config: SiftConfig): PlannerPromptBudget;
export { buildPlannerToolDefinitions };
export declare function summarizeRequest(request: SummaryRequest): Promise<SummaryResult>;
export declare function readSummaryInput(options: {
    text?: string;
    file?: string;
    stdinText?: string;
}): string | null;

import type { SiftConfig } from '../../config/index.js';
import { type LlamaCppChatMessage } from '../../providers/llama-cpp.js';
import type { PlannerToolDefinition, SummaryRequest } from '../types.js';
export declare function invokePlannerProviderAction(options: {
    requestId: string;
    slotId: number | null;
    config: SiftConfig;
    model: string;
    messages: LlamaCppChatMessage[];
    promptText: string;
    promptTokenCount: number;
    rawInputCharacterCount: number;
    chunkInputCharacterCount: number;
    toolDefinitions: PlannerToolDefinition[];
    reasoningOverride?: 'on' | 'off' | 'auto';
    requestTimeoutSeconds?: number;
    llamaCppOverrides?: SummaryRequest['llamaCppOverrides'];
}): Promise<{
    text: string;
    reasoningText: string | null;
    inputTokens: number | null;
    outputCharacterCount: number | null;
    outputTokens: number | null;
    thinkingTokens: number | null;
    promptCacheTokens: number | null;
    promptEvalTokens: number | null;
    requestDurationMs: number;
}>;

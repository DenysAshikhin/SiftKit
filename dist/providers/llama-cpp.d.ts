import { type RuntimeLlamaCppConfig, type SiftConfig } from '../config/index.js';
export type LlamaCppUsage = {
    promptTokens: number | null;
    completionTokens: number | null;
    totalTokens: number | null;
    thinkingTokens: number | null;
    promptCacheTokens: number | null;
    promptEvalTokens: number | null;
};
export type LlamaCppGenerateResult = {
    text: string;
    usage: LlamaCppUsage | null;
    reasoningText: string | null;
};
export type LlamaCppChatMessage = {
    role: 'system' | 'user' | 'assistant' | 'tool';
    content?: string | Array<{
        type?: string;
        text?: string;
    }>;
    tool_calls?: Array<{
        id?: string;
        type?: string;
        function?: {
            name?: string;
            arguments?: unknown;
        };
    }>;
    tool_call_id?: string;
    function_call?: {
        name?: string;
        arguments?: unknown;
    };
};
export type LlamaCppStructuredOutput = {
    kind: 'none';
} | {
    kind: 'siftkit-decision-json';
    allowUnsupportedInput?: boolean;
} | {
    kind: 'siftkit-planner-action-json';
    tools?: unknown[];
};
export declare function countLlamaCppTokens(config: SiftConfig, content: string): Promise<number | null>;
export declare function listLlamaCppModels(config: SiftConfig): Promise<string[]>;
export type LlamaCppProviderStatus = {
    Available: boolean;
    Reachable: boolean;
    BaseUrl: string | null;
    Error: string | null;
};
export declare function getLlamaCppProviderStatus(config: SiftConfig): Promise<LlamaCppProviderStatus>;
export declare function generateLlamaCppResponse(options: {
    config: SiftConfig;
    model: string;
    prompt: string;
    timeoutSeconds: number;
    slotId?: number;
    structuredOutput?: LlamaCppStructuredOutput;
    reasoningOverride?: 'on' | 'off' | 'auto';
    overrides?: Pick<RuntimeLlamaCppConfig, 'Temperature' | 'TopP' | 'TopK' | 'MinP' | 'PresencePenalty' | 'RepetitionPenalty' | 'MaxTokens'>;
}): Promise<LlamaCppGenerateResult>;
export declare function generateLlamaCppChatResponse(options: {
    config: SiftConfig;
    model: string;
    messages: LlamaCppChatMessage[];
    timeoutSeconds: number;
    slotId?: number;
    cachePrompt?: boolean;
    tools?: unknown[];
    structuredOutput?: LlamaCppStructuredOutput;
    reasoningOverride?: 'on' | 'off' | 'auto';
    overrides?: Pick<RuntimeLlamaCppConfig, 'Temperature' | 'TopP' | 'TopK' | 'MinP' | 'PresencePenalty' | 'RepetitionPenalty' | 'MaxTokens'>;
}): Promise<LlamaCppGenerateResult>;

#!/usr/bin/env node
declare const TASK_PACK: {
    id: string;
    question: string;
    signals: string[];
}[];
declare function parsePlannerAction(text: any): {
    action: string;
    tool_name: string;
    args: {
        command: any;
    };
    output?: undefined;
    confidence?: undefined;
} | {
    action: string;
    output: any;
    confidence: number;
    tool_name?: undefined;
    args?: undefined;
} | {
    action: string;
    output: any;
    tool_name?: undefined;
    args?: undefined;
    confidence?: undefined;
};
declare function evaluateCommandSafety(command: any, repoRoot?: string): {
    safe: boolean;
    reason: string;
} | {
    safe: boolean;
    reason: null;
};
declare function estimateTokenCount(config: any, text: any): number;
declare function resolveRepoSearchRequestMaxTokens(options?: {}): number;
declare function countTokensWithFallback(config: any, text: any): Promise<number>;
declare function preflightPlannerPromptBudget(options?: {}): Promise<{
    ok: boolean;
    promptTokenCount: number;
    maxPromptBudget: number;
    overflowTokens: number;
}>;
declare function compactPlannerMessagesOnce(options?: {}): Promise<{
    messages: any;
    droppedMessageCount: any;
    summaryInserted: boolean;
    promptTokenCount: number;
}>;
declare function runTaskLoop(task: any, options: any): Promise<{
    id: any;
    question: any;
    reason: string;
    turnsUsed: number;
    safetyRejects: number;
    invalidResponses: number;
    commandFailures: number;
    commands: ({
        command: any;
        safe: boolean;
        reason: string;
        exitCode: null;
        output: string;
    } | {
        command: string;
        safe: boolean;
        reason: string | null;
        exitCode: null;
        output: string;
    } | {
        command: string;
        safe: boolean;
        reason: null;
        exitCode: any;
        output: string;
    })[];
    finalOutput: string;
    passed: boolean;
    missingSignals: any[];
    promptTokens: number;
    promptCacheTokens: number;
    promptEvalTokens: number;
}>;
declare function buildScorecard(options: any): {
    runId: any;
    model: any;
    tasks: any;
    totals: {
        tasks: any;
        passed: any;
        failed: any;
        commandsExecuted: any;
        safetyRejects: any;
        invalidResponses: any;
        commandFailures: any;
        promptTokens: any;
        promptCacheTokens: any;
        promptEvalTokens: any;
    };
    verdict: string;
    failureReasons: string[];
};
declare function assertConfiguredModelPresent(model: any, availableModels: any): void;
declare function runMockRepoSearch(options?: {}): Promise<{
    runId: any;
    model: any;
    tasks: any;
    totals: {
        tasks: any;
        passed: any;
        failed: any;
        commandsExecuted: any;
        safetyRejects: any;
        invalidResponses: any;
        commandFailures: any;
        promptTokens: any;
        promptCacheTokens: any;
        promptEvalTokens: any;
    };
    verdict: string;
    failureReasons: string[];
}>;
export { TASK_PACK, parsePlannerAction, evaluateCommandSafety, runTaskLoop, buildScorecard, assertConfiguredModelPresent, runMockRepoSearch, resolveRepoSearchRequestMaxTokens, estimateTokenCount, countTokensWithFallback, preflightPlannerPromptBudget, compactPlannerMessagesOnce, };

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.invokePlannerProviderAction = invokePlannerProviderAction;
const index_js_1 = require("../../config/index.js");
const llama_cpp_js_1 = require("../../providers/llama-cpp.js");
const artifacts_js_1 = require("../artifacts.js");
async function invokePlannerProviderAction(options) {
    (0, artifacts_js_1.traceSummary)(`notify running=true phase=planner chunk=none raw_chars=${options.rawInputCharacterCount} `
        + `chunk_chars=${options.chunkInputCharacterCount} prompt_chars=${options.promptText.length}`);
    await (0, index_js_1.notifyStatusBackend)({
        running: true,
        requestId: options.requestId,
        promptCharacterCount: options.promptText.length,
        promptTokenCount: options.promptTokenCount,
        rawInputCharacterCount: options.rawInputCharacterCount,
        chunkInputCharacterCount: options.chunkInputCharacterCount,
        budgetSource: options.config.Effective?.BudgetSource ?? null,
        inputCharactersPerContextToken: options.config.Effective?.InputCharactersPerContextToken ?? null,
        chunkThresholdCharacters: options.config.Effective?.ChunkThresholdCharacters ?? null,
        phase: 'planner',
    });
    const startedAt = Date.now();
    let inputTokens = null;
    let outputCharacterCount = null;
    let outputTokens = null;
    let thinkingTokens = null;
    let promptCacheTokens = null;
    let promptEvalTokens = null;
    try {
        const response = await (0, llama_cpp_js_1.generateLlamaCppChatResponse)({
            config: options.config,
            model: options.model,
            messages: options.messages,
            timeoutSeconds: options.requestTimeoutSeconds ?? 600,
            slotId: options.slotId ?? undefined,
            cachePrompt: true,
            tools: options.toolDefinitions,
            structuredOutput: {
                kind: 'siftkit-planner-action-json',
                tools: options.toolDefinitions,
            },
            reasoningOverride: options.reasoningOverride,
            overrides: options.llamaCppOverrides,
        });
        inputTokens = response.usage?.promptTokens ?? null;
        outputCharacterCount = response.text.length;
        outputTokens = response.usage?.completionTokens ?? null;
        thinkingTokens = response.usage?.thinkingTokens ?? null;
        promptCacheTokens = response.usage?.promptCacheTokens ?? null;
        promptEvalTokens = response.usage?.promptEvalTokens ?? null;
        return {
            text: response.text,
            reasoningText: response.reasoningText,
            inputTokens,
            outputCharacterCount,
            outputTokens,
            thinkingTokens,
            promptCacheTokens,
            promptEvalTokens,
            requestDurationMs: Date.now() - startedAt,
        };
    }
    catch (error) {
        (0, artifacts_js_1.traceSummary)(`notify running=false phase=planner chunk=none duration_ms=${Date.now() - startedAt}`);
        await (0, index_js_1.notifyStatusBackend)({
            running: false,
            requestId: options.requestId,
            promptCharacterCount: options.promptText.length,
            inputTokens,
            outputCharacterCount,
            outputTokens,
            thinkingTokens,
            promptCacheTokens,
            promptEvalTokens,
            requestDurationMs: Date.now() - startedAt,
        });
        throw error;
    }
}

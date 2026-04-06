"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.invokeProviderSummary = invokeProviderSummary;
const index_js_1 = require("../config/index.js");
const llama_cpp_js_1 = require("../providers/llama-cpp.js");
const mock_js_1 = require("./mock.js");
const artifacts_js_1 = require("./artifacts.js");
const chunking_js_1 = require("./chunking.js");
async function invokeProviderSummary(options) {
    const chunkLabel = options.chunkPath ?? (options.chunkIndex !== null && options.chunkTotal !== null ? `${options.chunkIndex}/${options.chunkTotal}` : 'none');
    (0, artifacts_js_1.traceSummary)(`notify running=true phase=${options.phase} chunk=${chunkLabel} raw_chars=${options.rawInputCharacterCount} `
        + `chunk_chars=${options.chunkInputCharacterCount} prompt_chars=${options.promptCharacterCount}`);
    await (0, index_js_1.notifyStatusBackend)({
        running: true,
        requestId: options.requestId,
        promptCharacterCount: options.promptCharacterCount,
        promptTokenCount: options.promptTokenCount,
        rawInputCharacterCount: options.rawInputCharacterCount,
        chunkInputCharacterCount: options.chunkInputCharacterCount,
        budgetSource: options.config.Effective?.BudgetSource ?? null,
        inputCharactersPerContextToken: options.config.Effective?.InputCharactersPerContextToken ?? null,
        chunkThresholdCharacters: options.config.Effective?.ChunkThresholdCharacters ?? null,
        phase: options.phase,
        chunkIndex: options.chunkIndex,
        chunkTotal: options.chunkTotal,
        chunkPath: options.chunkPath,
    });
    const startedAt = Date.now();
    let inputTokens = null;
    let outputCharacterCount = null;
    let outputTokens = null;
    let thinkingTokens = null;
    let promptCacheTokens = null;
    let promptEvalTokens = null;
    try {
        if (options.backend === 'mock') {
            const rawSleep = process.env.SIFTKIT_TEST_PROVIDER_SLEEP_MS;
            const sleepMs = rawSleep ? Number.parseInt(rawSleep, 10) : 0;
            if (Number.isFinite(sleepMs) && sleepMs > 0) {
                await new Promise((resolve) => setTimeout(resolve, sleepMs));
            }
            (0, artifacts_js_1.appendTestProviderEvent)({
                backend: options.backend,
                model: options.model,
                phase: options.phase,
                question: options.question,
                rawInputCharacterCount: options.rawInputCharacterCount,
                chunkInputCharacterCount: options.chunkInputCharacterCount,
            });
            const mockSummary = (0, mock_js_1.getMockSummary)(options.prompt, options.question, options.phase);
            outputCharacterCount = mockSummary.length;
            return mockSummary;
        }
        (0, artifacts_js_1.traceSummary)(`provider start backend=${options.backend} model=${options.model} phase=${options.phase} `
            + `chunk=${chunkLabel} timeout_s=${options.requestTimeoutSeconds ?? 600}`);
        const response = await (0, llama_cpp_js_1.generateLlamaCppResponse)({
            config: options.config,
            model: options.model,
            prompt: options.prompt,
            timeoutSeconds: options.requestTimeoutSeconds ?? 600,
            slotId: options.slotId ?? undefined,
            reasoningOverride: options.reasoningOverride,
            structuredOutput: {
                kind: 'siftkit-decision-json',
                allowUnsupportedInput: options.backend !== 'llama.cpp' || options.phase === 'leaf' && options.chunkPath !== null,
            },
            overrides: options.llamaCppOverrides,
        });
        inputTokens = response.usage?.promptTokens ?? null;
        outputCharacterCount = response.text.length;
        outputTokens = response.usage?.completionTokens ?? null;
        thinkingTokens = response.usage?.thinkingTokens ?? null;
        promptCacheTokens = response.usage?.promptCacheTokens ?? null;
        promptEvalTokens = response.usage?.promptEvalTokens ?? null;
        (0, artifacts_js_1.traceSummary)(`provider done phase=${options.phase} chunk=${chunkLabel} output_chars=${outputCharacterCount} `
            + `output_tokens=${outputTokens ?? 'null'} thinking_tokens=${thinkingTokens ?? 'null'}`);
        return response.text.trim();
    }
    finally {
        const countOutputTokensAsThinking = options.phase === 'leaf' && options.chunkPath !== null;
        (0, artifacts_js_1.traceSummary)(`notify running=false phase=${options.phase} chunk=${chunkLabel} duration_ms=${Date.now() - startedAt}`);
        await (0, index_js_1.notifyStatusBackend)({
            running: false,
            requestId: options.requestId,
            promptCharacterCount: options.promptCharacterCount,
            inputTokens,
            outputCharacterCount,
            outputTokens: countOutputTokensAsThinking ? null : outputTokens,
            thinkingTokens: countOutputTokensAsThinking
                ? (0, chunking_js_1.sumTokenCounts)(thinkingTokens, outputTokens)
                : thinkingTokens,
            promptCacheTokens,
            promptEvalTokens,
            requestDurationMs: Date.now() - startedAt,
        });
    }
}

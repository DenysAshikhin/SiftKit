"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.PLANNER_TRIGGER_CONTEXT_RATIO = exports.MAX_TOKEN_AWARE_CHUNK_ADJUSTMENTS = exports.LLAMA_CPP_PROMPT_TOKEN_TARGET_TOLERANCE = void 0;
exports.splitTextIntoChunks = splitTextIntoChunks;
exports.countPromptTokensForChunk = countPromptTokensForChunk;
exports.planTokenAwareLlamaCppChunks = planTokenAwareLlamaCppChunks;
exports.shouldRetryWithSmallerChunks = shouldRetryWithSmallerChunks;
exports.getLlamaCppPromptTokenReserve = getLlamaCppPromptTokenReserve;
exports.allocateLlamaCppSlotId = allocateLlamaCppSlotId;
exports.getPlannerPromptBudget = getPlannerPromptBudget;
exports.estimatePromptTokenCount = estimatePromptTokenCount;
exports.getLlamaCppChunkThresholdCharacters = getLlamaCppChunkThresholdCharacters;
exports.getPlannerActivationThresholdCharacters = getPlannerActivationThresholdCharacters;
exports.getTokenAwareChunkThreshold = getTokenAwareChunkThreshold;
exports.sumTokenCounts = sumTokenCounts;
const index_js_1 = require("../config/index.js");
const llama_cpp_js_1 = require("../providers/llama-cpp.js");
const prompt_js_1 = require("./prompt.js");
const LLAMA_CPP_NON_THINKING_PROMPT_TOKEN_RESERVE = 10_000;
const LLAMA_CPP_THINKING_PROMPT_TOKEN_RESERVE = 15_000;
exports.LLAMA_CPP_PROMPT_TOKEN_TARGET_TOLERANCE = 2000;
exports.MAX_TOKEN_AWARE_CHUNK_ADJUSTMENTS = 8;
const MIN_PLANNER_HEADROOM_TOKENS = 4000;
const PLANNER_HEADROOM_RATIO = 0.15;
exports.PLANNER_TRIGGER_CONTEXT_RATIO = 0.75;
let nextLlamaCppSlotId = 0;
function splitTextIntoChunks(text, chunkSize) {
    if (chunkSize <= 0) {
        throw new Error('ChunkSize must be greater than zero.');
    }
    if (text.length <= chunkSize) {
        return [text];
    }
    const chunks = [];
    for (let offset = 0; offset < text.length; offset += chunkSize) {
        chunks.push(text.substring(offset, Math.min(offset + chunkSize, text.length)));
    }
    return chunks;
}
async function countPromptTokensForChunk(options) {
    const prompt = (0, prompt_js_1.buildPrompt)({
        question: options.question,
        inputText: options.inputText,
        format: options.format,
        policyProfile: options.policyProfile,
        rawReviewRequired: options.rawReviewRequired,
        promptPrefix: options.promptPrefix,
        sourceKind: options.sourceKind,
        commandExitCode: options.commandExitCode,
        phase: options.phase,
        chunkContext: options.chunkContext,
    });
    return (0, llama_cpp_js_1.countLlamaCppTokens)(options.config, prompt);
}
async function planTokenAwareLlamaCppChunks(options) {
    const effectivePromptLimit = getPlannerPromptBudget(options.config).usablePromptBudgetTokens;
    if (effectivePromptLimit <= 0) {
        return null;
    }
    const chunks = [];
    let offset = 0;
    while (offset < options.inputText.length) {
        const remainingLength = options.inputText.length - offset;
        const targetSlackTokens = Math.min(exports.LLAMA_CPP_PROMPT_TOKEN_TARGET_TOLERANCE, effectivePromptLimit);
        let candidateLength = Math.min(options.chunkThreshold, remainingLength);
        let acceptedChunk = null;
        let acceptedLength = 0;
        let rejectedLength = null;
        let adjustmentCount = 0;
        while (candidateLength > 0 && adjustmentCount < exports.MAX_TOKEN_AWARE_CHUNK_ADJUSTMENTS) {
            adjustmentCount += 1;
            const candidateText = options.inputText.substring(offset, offset + candidateLength);
            const promptTokenCount = await countPromptTokensForChunk({
                question: options.question,
                inputText: candidateText,
                format: options.format,
                policyProfile: options.policyProfile,
                rawReviewRequired: options.rawReviewRequired,
                promptPrefix: options.promptPrefix,
                sourceKind: options.sourceKind,
                commandExitCode: options.commandExitCode,
                config: options.config,
                phase: options.phase,
                chunkContext: options.chunkContext,
            });
            if (promptTokenCount === null) {
                return null;
            }
            if (promptTokenCount <= effectivePromptLimit) {
                acceptedChunk = candidateText;
                acceptedLength = candidateLength;
                const slackTokens = effectivePromptLimit - promptTokenCount;
                if (slackTokens <= targetSlackTokens
                    || candidateLength >= remainingLength
                    || rejectedLength === acceptedLength + 1) {
                    break;
                }
                if (rejectedLength !== null) {
                    candidateLength = Math.max(acceptedLength + 1, Math.floor((acceptedLength + rejectedLength) / 2));
                    continue;
                }
                const grownLength = Math.min(remainingLength, Math.max(acceptedLength + 1, Math.floor(acceptedLength * (effectivePromptLimit / Math.max(promptTokenCount, 1)))));
                if (grownLength <= acceptedLength) {
                    break;
                }
                candidateLength = grownLength;
                continue;
            }
            rejectedLength = candidateLength;
            if (acceptedLength > 0) {
                candidateLength = Math.max(acceptedLength + 1, Math.floor((acceptedLength + rejectedLength) / 2));
                continue;
            }
            const reducedLength = getTokenAwareChunkThreshold({
                inputLength: candidateLength,
                promptTokenCount,
                effectivePromptLimit,
            });
            if (reducedLength === null || reducedLength >= candidateLength) {
                return null;
            }
            candidateLength = reducedLength;
        }
        if (!acceptedChunk) {
            return null;
        }
        chunks.push(acceptedChunk);
        offset += acceptedChunk.length;
    }
    return chunks;
}
function shouldRetryWithSmallerChunks(options) {
    if (options.backend !== 'llama.cpp') {
        return false;
    }
    if (options.chunkThreshold <= 1 || options.inputText.length <= 1) {
        return false;
    }
    const message = options.error instanceof Error ? options.error.message : String(options.error);
    return /llama\.cpp generate failed with HTTP 400\b/iu.test(message);
}
function getLlamaCppPromptTokenReserve(config) {
    const reasoning = (0, index_js_1.getConfiguredLlamaSetting)(config, 'Reasoning');
    return reasoning === 'off'
        ? LLAMA_CPP_NON_THINKING_PROMPT_TOKEN_RESERVE
        : LLAMA_CPP_THINKING_PROMPT_TOKEN_RESERVE;
}
function allocateLlamaCppSlotId(config) {
    const configuredSlots = (0, index_js_1.getConfiguredLlamaSetting)(config, 'ParallelSlots');
    const slotCount = Math.max(1, Math.floor(Number(configuredSlots) || 1));
    const slotId = nextLlamaCppSlotId % slotCount;
    nextLlamaCppSlotId = (nextLlamaCppSlotId + 1) % slotCount;
    return slotId;
}
function getPlannerPromptBudget(config) {
    const numCtxTokens = (0, index_js_1.getConfiguredLlamaNumCtx)(config);
    const promptReserveTokens = getLlamaCppPromptTokenReserve(config);
    const usablePromptBudgetTokens = Math.max(numCtxTokens - promptReserveTokens, 0);
    const plannerHeadroomTokens = Math.max(Math.ceil(usablePromptBudgetTokens * PLANNER_HEADROOM_RATIO), MIN_PLANNER_HEADROOM_TOKENS);
    return {
        numCtxTokens,
        promptReserveTokens,
        usablePromptBudgetTokens,
        plannerHeadroomTokens,
        plannerStopLineTokens: Math.max(usablePromptBudgetTokens - plannerHeadroomTokens, 0),
    };
}
function estimatePromptTokenCount(config, text) {
    return Math.max(1, Math.ceil(text.length / Math.max((0, index_js_1.getEffectiveInputCharactersPerContextToken)(config), 0.1)));
}
function getLlamaCppChunkThresholdCharacters(config) {
    const reserveChars = Math.ceil(getLlamaCppPromptTokenReserve(config) * (0, index_js_1.getEffectiveInputCharactersPerContextToken)(config));
    return Math.max((0, index_js_1.getChunkThresholdCharacters)(config) - reserveChars, 1);
}
function getPlannerActivationThresholdCharacters(config) {
    return Math.max(1, Math.floor((0, index_js_1.getConfiguredLlamaNumCtx)(config) * (0, index_js_1.getEffectiveInputCharactersPerContextToken)(config) * exports.PLANNER_TRIGGER_CONTEXT_RATIO));
}
function getTokenAwareChunkThreshold(options) {
    if (options.inputLength <= 1
        || options.promptTokenCount <= options.effectivePromptLimit
        || options.effectivePromptLimit <= 0) {
        return null;
    }
    const scaledThreshold = Math.floor(options.inputLength * (options.effectivePromptLimit / options.promptTokenCount) * 0.95);
    const reducedThreshold = Math.max(1, Math.min(options.inputLength - 1, scaledThreshold));
    return reducedThreshold < options.inputLength ? reducedThreshold : null;
}
function sumTokenCounts(...values) {
    let total = 0;
    let hasValue = false;
    for (const value of values) {
        if (Number.isFinite(value)) {
            total += Number(value);
            hasValue = true;
        }
    }
    return hasValue ? total : null;
}

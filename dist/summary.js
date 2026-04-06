"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildPlannerToolDefinitions = exports.buildPrompt = exports.getDeterministicExcerpt = exports.UNSUPPORTED_INPUT_MESSAGE = void 0;
exports.getSummaryDecision = getSummaryDecision;
exports.planTokenAwareLlamaCppChunks = planTokenAwareLlamaCppChunks;
exports.getPlannerPromptBudget = getPlannerPromptBudget;
exports.summarizeRequest = summarizeRequest;
exports.readSummaryInput = readSummaryInput;
const fs = __importStar(require("node:fs"));
const node_crypto_1 = require("node:crypto");
const index_js_1 = require("./config/index.js");
const execution_lock_js_1 = require("./execution-lock.js");
const errors_js_1 = require("./lib/errors.js");
const llama_cpp_js_1 = require("./providers/llama-cpp.js");
const measure_js_1 = require("./summary/measure.js");
Object.defineProperty(exports, "UNSUPPORTED_INPUT_MESSAGE", { enumerable: true, get: function () { return measure_js_1.UNSUPPORTED_INPUT_MESSAGE; } });
Object.defineProperty(exports, "getDeterministicExcerpt", { enumerable: true, get: function () { return measure_js_1.getDeterministicExcerpt; } });
const prompt_js_1 = require("./summary/prompt.js");
Object.defineProperty(exports, "buildPrompt", { enumerable: true, get: function () { return prompt_js_1.buildPrompt; } });
const structured_js_1 = require("./summary/structured.js");
const mock_js_1 = require("./summary/mock.js");
const tools_js_1 = require("./summary/planner/tools.js");
Object.defineProperty(exports, "buildPlannerToolDefinitions", { enumerable: true, get: function () { return tools_js_1.buildPlannerToolDefinitions; } });
const parse_js_1 = require("./summary/planner/parse.js");
const artifacts_js_1 = require("./summary/artifacts.js");
const prompts_js_1 = require("./summary/planner/prompts.js");
function getCommandOutputRawReviewRequired(options) {
    if (options.riskLevel !== 'informational') {
        return true;
    }
    if (Number.isFinite(options.commandExitCode) && Number(options.commandExitCode) !== 0) {
        return true;
    }
    if (/\b(fatal|panic|traceback|segmentation fault|core dumped|assert(?:ion)? failed|uncaught exception|out of memory)\b/iu.test(options.text)) {
        return true;
    }
    return (options.errorMetrics.ErrorLineCount >= 3
        || (options.errorMetrics.NonEmptyLineCount >= 6
            && options.errorMetrics.ErrorRatio >= 0.5));
}
function getSummaryDecision(text, question, riskLevel, config, options) {
    const metrics = (0, measure_js_1.measureText)(text);
    const errorMetrics = (0, measure_js_1.getErrorSignalMetrics)(text);
    const hasMaterialErrorSignals = (errorMetrics.ErrorLineCount > 0
        && (errorMetrics.NonEmptyLineCount <= 20
            || (errorMetrics.ErrorLineCount >= 5 && errorMetrics.ErrorRatio >= 0.25)
            || errorMetrics.ErrorRatio >= 0.25));
    const isShort = (metrics.CharacterCount < Number(config.Thresholds.MinCharactersForSummary)
        && metrics.LineCount < Number(config.Thresholds.MinLinesForSummary));
    const sourceKind = options?.sourceKind || 'standalone';
    const rawReviewRequired = sourceKind === 'command-output'
        ? getCommandOutputRawReviewRequired({
            text,
            riskLevel,
            commandExitCode: options?.commandExitCode,
            errorMetrics,
        })
        : (riskLevel !== 'informational' || hasMaterialErrorSignals);
    const reason = isShort
        ? 'model-first-short'
        : (rawReviewRequired ? 'model-first-risk-review' : 'model-first');
    return {
        ShouldSummarize: true,
        Reason: question ? reason : 'model-first',
        RawReviewRequired: rawReviewRequired,
        CharacterCount: metrics.CharacterCount,
        LineCount: metrics.LineCount,
    };
}
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
        const targetSlackTokens = Math.min(LLAMA_CPP_PROMPT_TOKEN_TARGET_TOLERANCE, effectivePromptLimit);
        let candidateLength = Math.min(options.chunkThreshold, remainingLength);
        let acceptedChunk = null;
        let acceptedLength = 0;
        let rejectedLength = null;
        let adjustmentCount = 0;
        while (candidateLength > 0 && adjustmentCount < MAX_TOKEN_AWARE_CHUNK_ADJUSTMENTS) {
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
const LLAMA_CPP_NON_THINKING_PROMPT_TOKEN_RESERVE = 10_000;
const LLAMA_CPP_THINKING_PROMPT_TOKEN_RESERVE = 15_000;
const LLAMA_CPP_PROMPT_TOKEN_TARGET_TOLERANCE = 2000;
const MAX_TOKEN_AWARE_CHUNK_ADJUSTMENTS = 8;
const MAX_PLANNER_TOOL_CALLS = 30;
const MIN_PLANNER_HEADROOM_TOKENS = 4000;
const PLANNER_HEADROOM_RATIO = 0.15;
const PLANNER_TRIGGER_CONTEXT_RATIO = 0.75;
const PLANNER_FALLBACK_TO_CHUNKS = 'fallback_to_chunks';
let nextLlamaCppSlotId = 0;
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
    return Math.max(1, Math.floor((0, index_js_1.getConfiguredLlamaNumCtx)(config) * (0, index_js_1.getEffectiveInputCharactersPerContextToken)(config) * PLANNER_TRIGGER_CONTEXT_RATIO));
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
                ? sumTokenCounts(thinkingTokens, outputTokens)
                : thinkingTokens,
            promptCacheTokens,
            promptEvalTokens,
            requestDurationMs: Date.now() - startedAt,
        });
    }
}
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
async function invokePlannerMode(options) {
    if (options.backend !== 'llama.cpp') {
        return null;
    }
    const promptBudget = getPlannerPromptBudget(options.config);
    if (promptBudget.plannerStopLineTokens <= 0) {
        return null;
    }
    const toolDefinitions = (0, tools_js_1.buildPlannerToolDefinitions)();
    const toolResults = [];
    const messages = [
        {
            role: 'system',
            content: (0, prompts_js_1.buildPlannerSystemPrompt)({
                promptPrefix: options.promptPrefix,
                sourceKind: options.sourceKind,
                commandExitCode: options.commandExitCode,
                rawReviewRequired: options.rawReviewRequired,
                toolDefinitions,
            }),
        },
        {
            role: 'user',
            content: (0, prompts_js_1.buildPlannerInitialUserPrompt)({
                question: options.question,
                inputText: options.inputText,
            }),
        },
    ];
    const debugRecorder = (0, artifacts_js_1.createPlannerDebugRecorder)({
        requestId: options.requestId,
        question: options.question,
        inputText: options.inputText,
        sourceKind: options.sourceKind,
        commandExitCode: options.commandExitCode,
        commandText: options.debugCommand,
    });
    let invalidActionCount = 0;
    while (toolResults.length <= MAX_PLANNER_TOOL_CALLS) {
        const prompt = (0, prompts_js_1.renderPlannerTranscript)(messages);
        const promptTokenCount = (await (0, llama_cpp_js_1.countLlamaCppTokens)(options.config, prompt)) ?? estimatePromptTokenCount(options.config, prompt);
        debugRecorder.record({
            kind: 'planner_prompt',
            prompt,
            promptTokenCount,
            toolCallCount: toolResults.length,
            plannerBudget: promptBudget,
        });
        if (promptTokenCount > promptBudget.plannerStopLineTokens) {
            debugRecorder.finish({
                status: 'failed',
                reason: 'planner_headroom_exceeded',
                promptTokenCount,
                plannerBudget: promptBudget,
            });
            return null;
        }
        let providerResponse;
        try {
            providerResponse = await invokePlannerProviderAction({
                requestId: options.requestId,
                slotId: options.slotId,
                config: options.config,
                model: options.model,
                messages,
                promptText: prompt,
                promptTokenCount,
                rawInputCharacterCount: options.inputText.length,
                chunkInputCharacterCount: options.inputText.length,
                toolDefinitions,
                requestTimeoutSeconds: options.requestTimeoutSeconds,
                llamaCppOverrides: options.llamaCppOverrides,
            });
        }
        catch (error) {
            debugRecorder.finish({
                status: 'failed',
                reason: (0, errors_js_1.getErrorMessage)(error),
            });
            return null;
        }
        let countOutputTokens = false;
        try {
            debugRecorder.record({
                kind: 'planner_model_response',
                thinkingProcess: providerResponse.reasoningText,
                responseText: providerResponse.text,
            });
            let action;
            try {
                action = (0, parse_js_1.parsePlannerAction)(providerResponse.text);
            }
            catch (error) {
                if (toolResults.length === 0 && (0, structured_js_1.tryRecoverStructuredModelDecision)(providerResponse.text)) {
                    debugRecorder.finish({
                        status: 'fallback',
                        reason: 'planner_non_action_response',
                    });
                    return PLANNER_FALLBACK_TO_CHUNKS;
                }
                invalidActionCount += 1;
                const invalidResponseError = (0, errors_js_1.getErrorMessage)(error);
                if (providerResponse.text.trim()) {
                    messages.push({
                        role: 'assistant',
                        content: providerResponse.text,
                    });
                }
                messages.push({
                    role: 'user',
                    content: (0, prompts_js_1.buildPlannerInvalidResponseUserPrompt)(invalidResponseError),
                });
                debugRecorder.record({
                    kind: 'planner_invalid_response',
                    error: invalidResponseError,
                });
                if (invalidActionCount >= 2) {
                    debugRecorder.finish({
                        status: 'failed',
                        reason: 'planner_invalid_response_limit',
                    });
                    return null;
                }
                continue;
            }
            if (action.action === 'finish') {
                if (action.classification === 'unsupported_input' && options.sourceKind === 'command-output') {
                    const fallbackDecision = (0, structured_js_1.normalizeStructuredDecision)((0, structured_js_1.buildConservativeDirectFallbackDecision)({
                        inputText: options.inputText,
                        question: options.question,
                        format: options.format,
                        sourceKind: options.sourceKind,
                    }), options.format);
                    debugRecorder.finish({
                        status: 'completed',
                        command: options.debugCommand ?? null,
                        finalOutput: fallbackDecision.output,
                        classification: fallbackDecision.classification,
                        rawReviewRequired: fallbackDecision.rawReviewRequired,
                    });
                    return fallbackDecision;
                }
                countOutputTokens = true;
                const decision = (0, structured_js_1.normalizeStructuredDecision)({
                    classification: action.classification,
                    rawReviewRequired: action.rawReviewRequired,
                    output: action.output,
                }, options.format);
                debugRecorder.finish({
                    status: 'completed',
                    command: options.debugCommand ?? null,
                    finalOutput: decision.output,
                    classification: decision.classification,
                    rawReviewRequired: decision.rawReviewRequired,
                });
                return decision;
            }
            if (toolResults.length >= MAX_PLANNER_TOOL_CALLS) {
                debugRecorder.finish({
                    status: 'failed',
                    reason: 'planner_tool_call_limit',
                });
                return null;
            }
            let result;
            try {
                result = (0, tools_js_1.executePlannerTool)(options.inputText, action);
            }
            catch (error) {
                invalidActionCount += 1;
                const invalidResponseError = (0, errors_js_1.getErrorMessage)(error);
                messages.push((0, prompts_js_1.buildPlannerAssistantToolMessage)(action, `invalid_call_${invalidActionCount}`));
                messages.push({
                    role: 'user',
                    content: (0, prompts_js_1.buildPlannerInvalidResponseUserPrompt)(invalidResponseError),
                });
                debugRecorder.record({
                    kind: 'planner_invalid_response',
                    error: invalidResponseError,
                    toolCall: action,
                });
                if (invalidActionCount >= 2) {
                    debugRecorder.finish({
                        status: 'failed',
                        reason: 'planner_invalid_response_limit',
                    });
                    return null;
                }
                continue;
            }
            debugRecorder.record({
                kind: 'planner_tool',
                command: `${action.tool_name} ${JSON.stringify(action.args)}`,
                toolName: action.tool_name,
                args: action.args,
                output: result,
            });
            const formattedResultText = (0, tools_js_1.formatPlannerResult)(result);
            const remainingPromptTokens = Math.max(promptBudget.plannerStopLineTokens - promptTokenCount, 0);
            const resultTokenCount = (await (0, llama_cpp_js_1.countLlamaCppTokens)(options.config, formattedResultText)) ?? estimatePromptTokenCount(options.config, formattedResultText);
            const normalizedResultTokenCount = Math.max(0, Math.ceil(resultTokenCount));
            const promptResultText = normalizedResultTokenCount > (remainingPromptTokens * 0.7)
                ? (0, tools_js_1.formatPlannerToolResultTokenGuardError)(normalizedResultTokenCount)
                : formattedResultText;
            const toolCallId = `call_${toolResults.length + 1}`;
            messages.push((0, prompts_js_1.buildPlannerAssistantToolMessage)(action, toolCallId));
            messages.push({
                role: 'tool',
                tool_call_id: toolCallId,
                content: promptResultText,
            });
            toolResults.push({
                toolName: action.tool_name,
                args: action.args,
                result,
                resultText: promptResultText,
            });
        }
        finally {
            (0, artifacts_js_1.traceSummary)(`notify running=false phase=planner chunk=none duration_ms=${providerResponse.requestDurationMs}`);
            await (0, index_js_1.notifyStatusBackend)({
                running: false,
                requestId: options.requestId,
                promptCharacterCount: prompt.length,
                inputTokens: providerResponse.inputTokens,
                outputCharacterCount: providerResponse.outputCharacterCount,
                outputTokens: countOutputTokens ? providerResponse.outputTokens : null,
                thinkingTokens: countOutputTokens
                    ? providerResponse.thinkingTokens
                    : sumTokenCounts(providerResponse.thinkingTokens, providerResponse.outputTokens),
                promptCacheTokens: providerResponse.promptCacheTokens,
                promptEvalTokens: providerResponse.promptEvalTokens,
                requestDurationMs: providerResponse.requestDurationMs,
            });
        }
    }
    debugRecorder.finish({
        status: 'failed',
        reason: 'planner_exhausted_without_finish',
    });
    return null;
}
async function invokeSummaryCore(options) {
    const rootInputCharacterCount = options.rootInputCharacterCount ?? options.inputText.length;
    const phase = options.phase ?? 'leaf';
    const chunkThreshold = Math.max(1, Math.floor(options.chunkThresholdOverride ?? (options.backend === 'llama.cpp'
        ? getLlamaCppChunkThresholdCharacters(options.config)
        : (0, index_js_1.getChunkThresholdCharacters)(options.config))));
    const llamaPromptBudget = options.backend === 'llama.cpp'
        ? getPlannerPromptBudget(options.config)
        : null;
    const plannerActivationThreshold = options.backend === 'llama.cpp'
        ? getPlannerActivationThresholdCharacters(options.config)
        : chunkThreshold;
    const enforceNonToolOneShot = options.backend === 'llama.cpp'
        && options.inputText.length <= plannerActivationThreshold;
    const chunkLabel = options.chunkPath ?? (options.chunkIndex !== null && options.chunkTotal !== null ? `${options.chunkIndex}/${options.chunkTotal}` : 'none');
    (0, artifacts_js_1.traceSummary)(`invokeSummaryCore start phase=${phase} chunk=${chunkLabel} input_chars=${options.inputText.length} `
        + `chunk_threshold=${chunkThreshold} planner_threshold=${plannerActivationThreshold}`);
    const isTopLevelLlamaPass = options.backend === 'llama.cpp'
        && phase === 'leaf'
        && !options.chunkContext
        && options.chunkThresholdOverride == null;
    const plannerBudgetAvailable = options.backend === 'llama.cpp'
        && (llamaPromptBudget?.plannerStopLineTokens ?? 0) > 0;
    if (isTopLevelLlamaPass
        && plannerBudgetAvailable
        && options.inputText.length > plannerActivationThreshold) {
        const plannerDecision = await invokePlannerMode({
            requestId: options.requestId,
            slotId: options.slotId,
            question: options.question,
            inputText: options.inputText,
            format: options.format,
            backend: options.backend,
            model: options.model,
            config: options.config,
            rawReviewRequired: options.rawReviewRequired,
            sourceKind: options.sourceKind,
            commandExitCode: options.commandExitCode,
            debugCommand: options.debugCommand,
            promptPrefix: options.promptPrefix,
            requestTimeoutSeconds: options.requestTimeoutSeconds,
            llamaCppOverrides: options.llamaCppOverrides,
        });
        if (plannerDecision === PLANNER_FALLBACK_TO_CHUNKS) {
            // Fall through to normal chunking/provider flow.
        }
        else if (plannerDecision) {
            return plannerDecision;
        }
        else {
            throw new Error((0, artifacts_js_1.buildPlannerFailureErrorMessage)({
                requestId: options.requestId,
            }));
        }
    }
    if (options.inputText.length > chunkThreshold
        && !(options.backend === 'llama.cpp' && (llamaPromptBudget?.usablePromptBudgetTokens ?? 0) <= 0)) {
        const plannedChunks = options.backend === 'llama.cpp'
            ? await planTokenAwareLlamaCppChunks({
                question: options.question,
                inputText: options.inputText,
                format: options.format,
                policyProfile: options.policyProfile,
                rawReviewRequired: options.rawReviewRequired,
                promptPrefix: options.promptPrefix,
                sourceKind: options.sourceKind,
                commandExitCode: options.commandExitCode,
                config: options.config,
                chunkThreshold,
                phase,
                chunkContext: options.chunkContext,
            })
            : null;
        const chunks = plannedChunks && plannedChunks.length > 1
            ? plannedChunks
            : splitTextIntoChunks(options.inputText, chunkThreshold);
        if (chunks.length > 1) {
            const chunkDecisions = [];
            for (let index = 0; index < chunks.length; index += 1) {
                const childChunkPath = (0, prompt_js_1.appendChunkPath)(options.chunkPath ?? null, index + 1, chunks.length);
                chunkDecisions.push(await invokeSummaryCore({
                    ...options,
                    inputText: chunks[index],
                    phase,
                    chunkIndex: index + 1,
                    chunkTotal: chunks.length,
                    chunkPath: childChunkPath,
                    rootInputCharacterCount,
                    chunkThresholdOverride: chunkThreshold,
                    chunkContext: {
                        isGeneratedChunk: true,
                        mayBeTruncated: true,
                        retryMode: 'default',
                        chunkPath: childChunkPath,
                    },
                }));
            }
            const mergeLines = chunkDecisions
                .map((decision, index) => JSON.stringify({
                chunk: index + 1,
                classification: decision.classification,
                raw_review_required: decision.rawReviewRequired,
                output: decision.output,
            }));
            const mergeRequiresRawReview = chunkDecisions.some((decision) => decision.rawReviewRequired);
            const mergeInput = [
                `raw_review_required=${mergeRequiresRawReview ? 'true' : 'false'}`,
                ...mergeLines,
            ].join('\n');
            return invokeSummaryCore({
                ...options,
                question: options.question,
                inputText: mergeInput,
                phase: 'merge',
                chunkIndex: options.chunkIndex ?? null,
                chunkTotal: options.chunkTotal ?? null,
                chunkPath: options.chunkPath ?? null,
                rootInputCharacterCount,
                chunkThresholdOverride: chunkThreshold,
                chunkContext: undefined,
            });
        }
    }
    const allowUnsupportedInput = options.sourceKind !== 'command-output'
        && (options.backend !== 'llama.cpp' || (0, structured_js_1.isInternalChunkLeaf)(options));
    const prompt = (0, prompt_js_1.buildPrompt)({
        question: options.question,
        inputText: options.inputText,
        format: options.format,
        policyProfile: options.policyProfile,
        rawReviewRequired: options.rawReviewRequired,
        promptPrefix: options.promptPrefix,
        sourceKind: options.sourceKind,
        commandExitCode: options.commandExitCode,
        phase,
        chunkContext: options.chunkContext,
        allowUnsupportedInput,
    });
    const effectivePromptLimit = options.backend === 'llama.cpp'
        ? (llamaPromptBudget?.usablePromptBudgetTokens ?? 0)
        : null;
    (0, artifacts_js_1.traceSummary)(`preflight start phase=${phase} chunk=${chunkLabel} prompt_chars=${prompt.length} `
        + `effective_prompt_limit=${effectivePromptLimit ?? 'null'}`);
    const promptTokenCount = effectivePromptLimit !== null && effectivePromptLimit > 0
        ? await (0, llama_cpp_js_1.countLlamaCppTokens)(options.config, prompt)
        : null;
    (0, artifacts_js_1.traceSummary)(`preflight done phase=${phase} chunk=${chunkLabel} prompt_tokens=${promptTokenCount ?? 'null'}`);
    const preflightChunkThreshold = effectivePromptLimit !== null && promptTokenCount !== null
        ? getTokenAwareChunkThreshold({
            inputLength: options.inputText.length,
            promptTokenCount,
            effectivePromptLimit,
        })
        : null;
    if (preflightChunkThreshold !== null) {
        (0, artifacts_js_1.traceSummary)(`preflight recurse phase=${phase} chunk=${chunkLabel} reduced_chunk_threshold=${preflightChunkThreshold}`);
        return invokeSummaryCore({
            ...options,
            rootInputCharacterCount,
            chunkThresholdOverride: preflightChunkThreshold,
            chunkIndex: options.chunkIndex ?? null,
            chunkTotal: options.chunkTotal ?? null,
            chunkPath: options.chunkPath ?? null,
        });
    }
    try {
        const rawResponse = await invokeProviderSummary({
            requestId: options.requestId,
            slotId: options.slotId,
            backend: options.backend,
            config: options.config,
            model: options.model,
            prompt,
            question: options.question,
            promptCharacterCount: prompt.length,
            promptTokenCount,
            rawInputCharacterCount: rootInputCharacterCount,
            chunkInputCharacterCount: options.inputText.length,
            phase,
            chunkIndex: options.chunkIndex ?? null,
            chunkTotal: options.chunkTotal ?? null,
            chunkPath: options.chunkPath ?? null,
            reasoningOverride: enforceNonToolOneShot ? 'off' : undefined,
            requestTimeoutSeconds: options.requestTimeoutSeconds,
            llamaCppOverrides: options.llamaCppOverrides,
        });
        const parsedDecision = (0, structured_js_1.parseStructuredModelDecision)(rawResponse);
        if (parsedDecision.classification === 'unsupported_input') {
            if ((0, structured_js_1.isInternalChunkLeaf)(options)) {
                if (options.chunkContext?.retryMode !== 'strict') {
                    return invokeSummaryCore({
                        ...options,
                        rootInputCharacterCount,
                        chunkContext: {
                            ...(options.chunkContext ?? {
                                isGeneratedChunk: true,
                                mayBeTruncated: true,
                                chunkPath: options.chunkPath ?? null,
                            }),
                            retryMode: 'strict',
                        },
                    });
                }
                return (0, structured_js_1.normalizeStructuredDecision)((0, structured_js_1.buildConservativeChunkFallbackDecision)({
                    inputText: options.inputText,
                    question: options.question,
                    format: options.format,
                }), options.format);
            }
            if (!allowUnsupportedInput) {
                return (0, structured_js_1.normalizeStructuredDecision)((0, structured_js_1.buildConservativeDirectFallbackDecision)({
                    inputText: options.inputText,
                    question: options.question,
                    format: options.format,
                    sourceKind: options.sourceKind,
                }), options.format);
            }
        }
        return (0, structured_js_1.normalizeStructuredDecision)(parsedDecision, options.format);
    }
    catch (error) {
        const enrichedError = (0, artifacts_js_1.attachSummaryFailureContext)(error, {
            requestId: options.requestId,
            promptCharacterCount: prompt.length,
            promptTokenCount,
            rawInputCharacterCount: rootInputCharacterCount,
            chunkInputCharacterCount: options.inputText.length,
            chunkIndex: options.chunkIndex ?? null,
            chunkTotal: options.chunkTotal ?? null,
            chunkPath: options.chunkPath ?? null,
        });
        if (!shouldRetryWithSmallerChunks({
            error: enrichedError,
            backend: options.backend,
            inputText: options.inputText,
            chunkThreshold,
        })) {
            throw enrichedError;
        }
        const reducedThreshold = (effectivePromptLimit !== null && promptTokenCount !== null
            ? getTokenAwareChunkThreshold({
                inputLength: options.inputText.length,
                promptTokenCount,
                effectivePromptLimit,
            })
            : null) ?? Math.max(1, Math.min(chunkThreshold - 1, Math.floor(options.inputText.length / 2)));
        if (reducedThreshold >= options.inputText.length) {
            throw enrichedError;
        }
        return invokeSummaryCore({
            ...options,
            rootInputCharacterCount,
            chunkThresholdOverride: reducedThreshold,
            chunkIndex: options.chunkIndex ?? null,
            chunkTotal: options.chunkTotal ?? null,
            chunkPath: options.chunkPath ?? null,
        });
    }
}
function getPolicyDecision(classification) {
    if (classification === 'command_failure') {
        return 'model-command-failure';
    }
    if (classification === 'unsupported_input') {
        return 'model-unsupported-input';
    }
    return 'model-summary';
}
async function summarizeRequest(request) {
    const inputText = (0, measure_js_1.normalizeInputText)(request.inputText);
    if (!inputText || !inputText.trim()) {
        throw new Error('Provide --text, --file, or pipe input into siftkit.');
    }
    const requestId = (0, node_crypto_1.randomUUID)();
    (0, artifacts_js_1.traceSummary)(`summarizeRequest start input_chars=${inputText.length}`);
    return (0, execution_lock_js_1.withExecutionLock)(async () => {
        let config = null;
        let backend = request.backend || 'unknown';
        let model = request.model || 'unknown';
        try {
            (0, artifacts_js_1.traceSummary)('loadConfig start');
            config = await (0, index_js_1.loadConfig)({ ensure: true });
            (0, artifacts_js_1.traceSummary)('loadConfig done');
            (0, index_js_1.getConfiguredLlamaBaseUrl)(config);
            (0, index_js_1.getConfiguredLlamaNumCtx)(config);
            backend = request.backend || config.Backend;
            model = request.model || (0, index_js_1.getConfiguredModel)(config);
            const riskLevel = request.policyProfile === 'risky-operation' ? 'risky' : 'informational';
            const sourceKind = request.sourceKind || 'standalone';
            const maxInputCharacters = (0, index_js_1.getChunkThresholdCharacters)(config) * 4;
            if (backend !== 'llama.cpp' && inputText.length > maxInputCharacters) {
                throw new Error(`Error: recieved input of ${inputText.length} characters, current maximum is ${maxInputCharacters} chars`);
            }
            const decision = getSummaryDecision(inputText, request.question, riskLevel, config, {
                sourceKind,
                commandExitCode: request.commandExitCode,
            });
            const errorMetrics = (0, measure_js_1.getErrorSignalMetrics)(inputText);
            if (sourceKind === 'command-output'
                && Number.isFinite(request.commandExitCode)
                && (0, measure_js_1.isPassFailQuestion)(request.question)
                && errorMetrics.ErrorLineCount === 0) {
                const excerpt = (0, measure_js_1.getDeterministicExcerpt)(inputText, request.question)
                    || inputText.trim().split(/\r?\n/u).slice(0, 3).join('\n');
                const passed = Number(request.commandExitCode) === 0;
                const result = {
                    RequestId: requestId,
                    WasSummarized: true,
                    PolicyDecision: 'deterministic-pass-fail',
                    Backend: backend,
                    Model: model,
                    Summary: excerpt
                        ? `${passed ? 'PASS' : 'FAIL'}: command exit code was ${Number(request.commandExitCode)} and the captured output contains no obvious error signals. Observed output: ${excerpt}`
                        : `${passed ? 'PASS' : 'FAIL'}: command exit code was ${Number(request.commandExitCode)} and the captured output contains no obvious error signals.`,
                    Classification: 'summary',
                    RawReviewRequired: false,
                    ModelCallSucceeded: true,
                    ProviderError: null,
                };
                await (0, artifacts_js_1.writeSummaryRequestDump)({
                    requestId,
                    question: request.question,
                    inputText,
                    command: request.debugCommand ?? null,
                    backend,
                    model,
                    classification: result.Classification,
                    rawReviewRequired: result.RawReviewRequired,
                    summary: result.Summary,
                    providerError: result.ProviderError,
                    error: null,
                });
                (0, artifacts_js_1.clearSummaryArtifactState)(requestId);
                return result;
            }
            (0, artifacts_js_1.traceSummary)(`decision ready backend=${backend} model=${model} raw_review_required=${decision.RawReviewRequired} `
                + `chars=${decision.CharacterCount} lines=${decision.LineCount}`);
            const slotId = backend === 'llama.cpp' ? allocateLlamaCppSlotId(config) : null;
            const effectivePromptPrefix = request.promptPrefix !== undefined
                ? request.promptPrefix
                : (0, index_js_1.getConfiguredPromptPrefix)(config);
            (0, artifacts_js_1.traceSummary)('invokeSummaryCore start');
            const modelDecision = await invokeSummaryCore({
                requestId,
                slotId,
                question: request.question,
                inputText,
                format: request.format,
                policyProfile: request.policyProfile,
                backend,
                model,
                config,
                rawReviewRequired: decision.RawReviewRequired,
                sourceKind,
                commandExitCode: request.commandExitCode,
                debugCommand: request.debugCommand,
                promptPrefix: effectivePromptPrefix,
                requestTimeoutSeconds: request.requestTimeoutSeconds,
                llamaCppOverrides: request.llamaCppOverrides,
            });
            (0, artifacts_js_1.traceSummary)(`invokeSummaryCore done classification=${modelDecision.classification}`);
            try {
                await (0, index_js_1.notifyStatusBackend)({
                    running: false,
                    requestId,
                    terminalState: 'completed',
                    rawInputCharacterCount: inputText.length,
                });
            }
            catch {
                (0, artifacts_js_1.traceSummary)(`terminal status post failed request_id=${requestId} state=completed`);
            }
            await (0, artifacts_js_1.finalizePlannerDebugDump)({
                requestId,
                finalOutput: modelDecision.output.trim(),
                classification: modelDecision.classification,
                rawReviewRequired: modelDecision.rawReviewRequired,
                providerError: null,
            });
            const result = {
                RequestId: requestId,
                WasSummarized: modelDecision.classification !== 'unsupported_input',
                PolicyDecision: getPolicyDecision(modelDecision.classification),
                Backend: backend,
                Model: model,
                Summary: modelDecision.output.trim(),
                Classification: modelDecision.classification,
                RawReviewRequired: modelDecision.rawReviewRequired,
                ModelCallSucceeded: true,
                ProviderError: null,
            };
            await (0, artifacts_js_1.writeSummaryRequestDump)({
                requestId,
                question: request.question,
                inputText,
                command: request.debugCommand ?? null,
                backend,
                model,
                classification: result.Classification,
                rawReviewRequired: result.RawReviewRequired,
                summary: result.Summary,
                providerError: result.ProviderError,
                error: null,
            });
            (0, artifacts_js_1.clearSummaryArtifactState)(requestId);
            return result;
        }
        catch (error) {
            const failureContext = (0, artifacts_js_1.getSummaryFailureContext)(error);
            if (config !== null) {
                try {
                    await (0, index_js_1.notifyStatusBackend)({
                        running: false,
                        requestId,
                        terminalState: 'failed',
                        errorMessage: (0, errors_js_1.getErrorMessage)(error),
                        promptCharacterCount: failureContext?.promptCharacterCount ?? null,
                        promptTokenCount: failureContext?.promptTokenCount ?? null,
                        rawInputCharacterCount: failureContext?.rawInputCharacterCount ?? inputText.length,
                        chunkInputCharacterCount: failureContext?.chunkInputCharacterCount ?? null,
                        chunkIndex: failureContext?.chunkIndex ?? null,
                        chunkTotal: failureContext?.chunkTotal ?? null,
                        chunkPath: failureContext?.chunkPath ?? null,
                    });
                }
                catch {
                    (0, artifacts_js_1.traceSummary)(`terminal status post failed request_id=${requestId} state=failed`);
                }
            }
            await (0, artifacts_js_1.finalizePlannerDebugDump)({
                requestId,
                finalOutput: (0, errors_js_1.getErrorMessage)(error),
                classification: 'command_failure',
                rawReviewRequired: true,
                providerError: (0, errors_js_1.getErrorMessage)(error),
            });
            if (/planner/iu.test((0, errors_js_1.getErrorMessage)(error))) {
                await (0, artifacts_js_1.writeFailedRequestDump)({
                    requestId,
                    question: request.question,
                    inputText,
                    command: request.debugCommand ?? null,
                    error: (0, errors_js_1.getErrorMessage)(error),
                    providerError: (0, errors_js_1.getErrorMessage)(error),
                });
            }
            (0, artifacts_js_1.clearSummaryArtifactState)(requestId);
            throw error;
        }
    });
}
function readSummaryInput(options) {
    if (options.text !== undefined) {
        return (0, measure_js_1.normalizeInputText)(options.text);
    }
    if (options.file) {
        if (!fs.existsSync(options.file)) {
            if (options.stdinText !== undefined) {
                return (0, measure_js_1.normalizeInputText)(options.stdinText);
            }
            throw new Error(`Input file not found: ${options.file}`);
        }
        return (0, measure_js_1.normalizeInputText)(fs.readFileSync(options.file, 'utf8'));
    }
    if (options.stdinText !== undefined) {
        return (0, measure_js_1.normalizeInputText)(options.stdinText);
    }
    return null;
}

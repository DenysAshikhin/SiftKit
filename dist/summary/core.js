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
exports.summarizeRequest = summarizeRequest;
exports.readSummaryInput = readSummaryInput;
const fs = __importStar(require("node:fs"));
const node_crypto_1 = require("node:crypto");
const index_js_1 = require("../config/index.js");
const execution_lock_js_1 = require("../execution-lock.js");
const errors_js_1 = require("../lib/errors.js");
const llama_cpp_js_1 = require("../providers/llama-cpp.js");
const measure_js_1 = require("./measure.js");
const prompt_js_1 = require("./prompt.js");
const structured_js_1 = require("./structured.js");
const artifacts_js_1 = require("./artifacts.js");
const chunking_js_1 = require("./chunking.js");
const decision_js_1 = require("./decision.js");
const provider_invoke_js_1 = require("./provider-invoke.js");
const mode_js_1 = require("./planner/mode.js");
async function invokeSummaryCore(options) {
    const rootInputCharacterCount = options.rootInputCharacterCount ?? options.inputText.length;
    const phase = options.phase ?? 'leaf';
    const chunkThreshold = Math.max(1, Math.floor(options.chunkThresholdOverride ?? (options.backend === 'llama.cpp'
        ? (0, chunking_js_1.getLlamaCppChunkThresholdCharacters)(options.config)
        : (0, index_js_1.getChunkThresholdCharacters)(options.config))));
    const llamaPromptBudget = options.backend === 'llama.cpp'
        ? (0, chunking_js_1.getPlannerPromptBudget)(options.config)
        : null;
    const plannerActivationThreshold = options.backend === 'llama.cpp'
        ? (0, chunking_js_1.getPlannerActivationThresholdCharacters)(options.config)
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
        const plannerDecision = await (0, mode_js_1.invokePlannerMode)({
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
        if (plannerDecision === mode_js_1.PLANNER_FALLBACK_TO_CHUNKS) {
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
            ? await (0, chunking_js_1.planTokenAwareLlamaCppChunks)({
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
            : (0, chunking_js_1.splitTextIntoChunks)(options.inputText, chunkThreshold);
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
        ? (0, chunking_js_1.getTokenAwareChunkThreshold)({
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
        const rawResponse = await (0, provider_invoke_js_1.invokeProviderSummary)({
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
        if (!(0, chunking_js_1.shouldRetryWithSmallerChunks)({
            error: enrichedError,
            backend: options.backend,
            inputText: options.inputText,
            chunkThreshold,
        })) {
            throw enrichedError;
        }
        const reducedThreshold = (effectivePromptLimit !== null && promptTokenCount !== null
            ? (0, chunking_js_1.getTokenAwareChunkThreshold)({
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
            const decision = (0, decision_js_1.getSummaryDecision)(inputText, request.question, riskLevel, config, {
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
            const slotId = backend === 'llama.cpp' ? (0, chunking_js_1.allocateLlamaCppSlotId)(config) : null;
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
                PolicyDecision: (0, decision_js_1.getPolicyDecision)(modelDecision.classification),
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

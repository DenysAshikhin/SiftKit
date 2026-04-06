"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.PLANNER_FALLBACK_TO_CHUNKS = void 0;
exports.invokePlannerMode = invokePlannerMode;
const llama_cpp_js_1 = require("../../providers/llama-cpp.js");
const errors_js_1 = require("../../lib/errors.js");
const structured_js_1 = require("../structured.js");
const tools_js_1 = require("./tools.js");
const parse_js_1 = require("./parse.js");
const artifacts_js_1 = require("../artifacts.js");
const prompts_js_1 = require("./prompts.js");
const chunking_js_1 = require("../chunking.js");
const index_js_1 = require("../../config/index.js");
const provider_js_1 = require("./provider.js");
const MAX_PLANNER_TOOL_CALLS = 30;
exports.PLANNER_FALLBACK_TO_CHUNKS = 'fallback_to_chunks';
async function invokePlannerMode(options) {
    if (options.backend !== 'llama.cpp') {
        return null;
    }
    const promptBudget = (0, chunking_js_1.getPlannerPromptBudget)(options.config);
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
        const promptTokenCount = (await (0, llama_cpp_js_1.countLlamaCppTokens)(options.config, prompt)) ?? (0, chunking_js_1.estimatePromptTokenCount)(options.config, prompt);
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
            providerResponse = await (0, provider_js_1.invokePlannerProviderAction)({
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
                reasoningOverride: 'off',
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
                    return exports.PLANNER_FALLBACK_TO_CHUNKS;
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
                debugRecorder.record({
                    kind: 'planner_forced_finish',
                    reason: 'planner_tool_call_limit',
                    toolCallCount: toolResults.length,
                });
                messages.push({
                    role: 'user',
                    content: (0, prompts_js_1.buildPlannerForcedFinishUserPrompt)(),
                });
                try {
                    const forcedPrompt = (0, prompts_js_1.renderPlannerTranscript)(messages);
                    const forcedPromptTokenCount = (await (0, llama_cpp_js_1.countLlamaCppTokens)(options.config, forcedPrompt)) ?? (0, chunking_js_1.estimatePromptTokenCount)(options.config, forcedPrompt);
                    const forcedResponse = await (0, provider_js_1.invokePlannerProviderAction)({
                        requestId: options.requestId,
                        slotId: options.slotId,
                        config: options.config,
                        model: options.model,
                        messages,
                        promptText: forcedPrompt,
                        promptTokenCount: forcedPromptTokenCount,
                        rawInputCharacterCount: options.inputText.length,
                        chunkInputCharacterCount: options.inputText.length,
                        toolDefinitions,
                        requestTimeoutSeconds: options.requestTimeoutSeconds,
                        llamaCppOverrides: options.llamaCppOverrides,
                    });
                    const forcedAction = (0, parse_js_1.parsePlannerAction)(forcedResponse.text);
                    if (forcedAction.action === 'finish') {
                        const forcedDecision = (0, structured_js_1.normalizeStructuredDecision)({
                            classification: forcedAction.classification,
                            rawReviewRequired: forcedAction.rawReviewRequired,
                            output: forcedAction.output,
                        }, options.format);
                        debugRecorder.finish({
                            status: 'completed',
                            command: options.debugCommand ?? null,
                            finalOutput: forcedDecision.output,
                            classification: forcedDecision.classification,
                            rawReviewRequired: forcedDecision.rawReviewRequired,
                        });
                        return forcedDecision;
                    }
                }
                catch {
                    // forced finish failed — fall through to null
                }
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
            const resultTokenCount = (await (0, llama_cpp_js_1.countLlamaCppTokens)(options.config, formattedResultText)) ?? (0, chunking_js_1.estimatePromptTokenCount)(options.config, formattedResultText);
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
                    : (0, chunking_js_1.sumTokenCounts)(providerResponse.thinkingTokens, providerResponse.outputTokens),
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

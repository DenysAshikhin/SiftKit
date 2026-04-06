import type { SiftConfig } from '../../config/index.js';
import {
  countLlamaCppTokens,
  type LlamaCppChatMessage,
} from '../../providers/llama-cpp.js';
import { getErrorMessage } from '../../lib/errors.js';
import {
  buildConservativeDirectFallbackDecision,
  normalizeStructuredDecision,
  tryRecoverStructuredModelDecision,
} from '../structured.js';
import {
  buildPlannerToolDefinitions,
  executePlannerTool,
  formatPlannerResult,
  formatPlannerToolResultTokenGuardError,
} from './tools.js';
import { parsePlannerAction } from './parse.js';
import {
  createPlannerDebugRecorder,
  buildPlannerFailureErrorMessage,
  traceSummary,
} from '../artifacts.js';
import {
  buildPlannerAssistantToolMessage,
  buildPlannerForcedFinishUserPrompt,
  buildPlannerInitialUserPrompt,
  buildPlannerInvalidResponseUserPrompt,
  buildPlannerSystemPrompt,
  renderPlannerTranscript,
} from './prompts.js';
import {
  estimatePromptTokenCount,
  getPlannerPromptBudget,
  sumTokenCounts,
} from '../chunking.js';
import { notifyStatusBackend } from '../../config/index.js';
import { invokePlannerProviderAction } from './provider.js';
import type {
  PlannerAction,
  PlannerToolName,
  StructuredModelDecision,
  SummaryRequest,
  SummarySourceKind,
} from '../types.js';

const MAX_PLANNER_TOOL_CALLS = 30;
export const PLANNER_FALLBACK_TO_CHUNKS = 'fallback_to_chunks';

export async function invokePlannerMode(options: {
  requestId: string;
  slotId: number | null;
  question: string;
  inputText: string;
  format: 'text' | 'json';
  backend: string;
  model: string;
  config: SiftConfig;
  rawReviewRequired: boolean;
  sourceKind: SummarySourceKind;
  commandExitCode?: number | null;
  debugCommand?: string | null;
  promptPrefix?: string;
  requestTimeoutSeconds?: number;
  llamaCppOverrides?: SummaryRequest['llamaCppOverrides'];
}): Promise<StructuredModelDecision | null | typeof PLANNER_FALLBACK_TO_CHUNKS> {
  if (options.backend !== 'llama.cpp') {
    return null;
  }

  const promptBudget = getPlannerPromptBudget(options.config);
  if (promptBudget.plannerStopLineTokens <= 0) {
    return null;
  }

  const toolDefinitions = buildPlannerToolDefinitions();
  const toolResults: Array<{ toolName: PlannerToolName; args: Record<string, unknown>; result: unknown; resultText: string }> = [];
  const messages: LlamaCppChatMessage[] = [
    {
      role: 'system',
      content: buildPlannerSystemPrompt({
        promptPrefix: options.promptPrefix,
        sourceKind: options.sourceKind,
        commandExitCode: options.commandExitCode,
        rawReviewRequired: options.rawReviewRequired,
        toolDefinitions,
      }),
    },
    {
      role: 'user',
      content: buildPlannerInitialUserPrompt({
        question: options.question,
        inputText: options.inputText,
      }),
    },
  ];
  const debugRecorder = createPlannerDebugRecorder({
    requestId: options.requestId,
    question: options.question,
    inputText: options.inputText,
    sourceKind: options.sourceKind,
    commandExitCode: options.commandExitCode,
    commandText: options.debugCommand,
  });
  let invalidActionCount = 0;

  while (toolResults.length <= MAX_PLANNER_TOOL_CALLS) {
    const prompt = renderPlannerTranscript(messages);
    const promptTokenCount = (
      await countLlamaCppTokens(options.config, prompt)
    ) ?? estimatePromptTokenCount(options.config, prompt);
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

    let providerResponse: {
      text: string;
      reasoningText: string | null;
      inputTokens: number | null;
      outputCharacterCount: number | null;
      outputTokens: number | null;
      thinkingTokens: number | null;
      promptCacheTokens: number | null;
      promptEvalTokens: number | null;
      requestDurationMs: number;
    };
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
        reasoningOverride: 'off',
        requestTimeoutSeconds: options.requestTimeoutSeconds,
        llamaCppOverrides: options.llamaCppOverrides,
      });
    } catch (error) {
      debugRecorder.finish({
        status: 'failed',
        reason: getErrorMessage(error),
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

      let action: PlannerAction;
      try {
        action = parsePlannerAction(providerResponse.text);
      } catch (error) {
        if (toolResults.length === 0 && tryRecoverStructuredModelDecision(providerResponse.text)) {
          debugRecorder.finish({
            status: 'fallback',
            reason: 'planner_non_action_response',
          });
          return PLANNER_FALLBACK_TO_CHUNKS;
        }
        invalidActionCount += 1;
        const invalidResponseError = getErrorMessage(error);
        if (providerResponse.text.trim()) {
          messages.push({
            role: 'assistant',
            content: providerResponse.text,
          });
        }
        messages.push({
          role: 'user',
          content: buildPlannerInvalidResponseUserPrompt(invalidResponseError),
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
          const fallbackDecision = normalizeStructuredDecision(
            buildConservativeDirectFallbackDecision({
              inputText: options.inputText,
              question: options.question,
              format: options.format,
              sourceKind: options.sourceKind,
            }),
            options.format,
          );
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
        const decision = normalizeStructuredDecision({
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
          content: buildPlannerForcedFinishUserPrompt(),
        });
        try {
          const forcedPrompt = renderPlannerTranscript(messages);
          const forcedPromptTokenCount = (
            await countLlamaCppTokens(options.config, forcedPrompt)
          ) ?? estimatePromptTokenCount(options.config, forcedPrompt);
          const forcedResponse = await invokePlannerProviderAction({
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
          const forcedAction = parsePlannerAction(forcedResponse.text);
          if (forcedAction.action === 'finish') {
            const forcedDecision = normalizeStructuredDecision({
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
        } catch {
          // forced finish failed — fall through to null
        }
        debugRecorder.finish({
          status: 'failed',
          reason: 'planner_tool_call_limit',
        });
        return null;
      }

      let result: Record<string, unknown>;
      try {
        result = executePlannerTool(options.inputText, action);
      } catch (error) {
        invalidActionCount += 1;
        const invalidResponseError = getErrorMessage(error);
        messages.push(buildPlannerAssistantToolMessage(action, `invalid_call_${invalidActionCount}`));
        messages.push({
          role: 'user',
          content: buildPlannerInvalidResponseUserPrompt(invalidResponseError),
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
      const formattedResultText = formatPlannerResult(result);
      const remainingPromptTokens = Math.max(promptBudget.plannerStopLineTokens - promptTokenCount, 0);
      const resultTokenCount = (
        await countLlamaCppTokens(options.config, formattedResultText)
      ) ?? estimatePromptTokenCount(options.config, formattedResultText);
      const normalizedResultTokenCount = Math.max(0, Math.ceil(resultTokenCount));
      const promptResultText = normalizedResultTokenCount > (remainingPromptTokens * 0.7)
        ? formatPlannerToolResultTokenGuardError(normalizedResultTokenCount)
        : formattedResultText;
      const toolCallId = `call_${toolResults.length + 1}`;
      messages.push(buildPlannerAssistantToolMessage(action, toolCallId));
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
    } finally {
      traceSummary(`notify running=false phase=planner chunk=none duration_ms=${providerResponse.requestDurationMs}`);
      await notifyStatusBackend({
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

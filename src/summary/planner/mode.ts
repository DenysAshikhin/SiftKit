import type { SiftConfig } from '../../config/index.js';
import {
  createEmptyToolTypeStats,
  getPlannerPromptBaselinePerToolAllowanceTokens,
  readLatestIdleSummaryToolStats,
} from '../../line-read-guidance.js';
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
import {
  buildRepeatedToolCallSummary,
  buildPromptToolResult,
  buildToolReplayFingerprint,
  classifyToolResultNovelty,
  fingerprintToolCall,
} from '../../tool-loop-governor.js';

const MAX_PLANNER_TOOL_CALLS = 30;
export const PLANNER_FALLBACK_TO_CHUNKS = 'fallback_to_chunks';
const PLANNER_FORCED_FINISH_MAX_ATTEMPTS = 2;
const PLANNER_STAGNATION_WARNING_THRESHOLD = 3;
const PLANNER_STAGNATION_FORCE_THRESHOLD = 4;

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
  allowedTools?: PlannerToolName[];
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

  const allowedTools: PlannerToolName[] = Array.isArray(options.allowedTools) && options.allowedTools.length > 0
    ? options.allowedTools
    : ['find_text', 'read_lines', 'json_filter'];
  const toolDefinitions = buildPlannerToolDefinitions(allowedTools);
  const historicalToolStats = readLatestIdleSummaryToolStats();
  const initialPerToolAllowanceTokens = getPlannerPromptBaselinePerToolAllowanceTokens(options.config);
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
        lineReadGuidance: {
          toolName: 'read_lines',
          toolStats: historicalToolStats,
          initialPerToolAllowanceTokens,
        },
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
  let forcedFinishAttemptsRemaining = 0;
  let consecutiveNoNewEvidence = 0;
  let consecutiveSemanticRepeats = 0;
  let lastSuccessfulFingerprint: string | null = null;
  const recentEvidenceKeys = new Set<string>();
  let lastReplayFingerprint: string | null = null;
  let replayRepeatCount = 0;
  let lastReplayToolMessageIndex = -1;

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
    let countToolTokens = false;
    let toolStatsPayload: Record<string, {
      calls: number;
      outputCharsTotal: number;
      outputTokensTotal: number;
      outputTokensEstimatedCount: number;
      lineReadCalls: number;
      lineReadLinesTotal: number;
      lineReadTokensTotal: number;
      finishRejections: number;
      semanticRepeatRejects: number;
      stagnationWarnings: number;
      forcedFinishFromStagnation: number;
      promptInsertedTokens: number;
      rawToolResultTokens: number;
      newEvidenceCalls: number;
      noNewEvidenceCalls: number;
    }> | null = null;
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

      if (forcedFinishAttemptsRemaining > 0 && action.action !== 'finish') {
        forcedFinishAttemptsRemaining = Math.max(forcedFinishAttemptsRemaining - 1, 0);
        if (providerResponse.text.trim()) {
          messages.push({
            role: 'assistant',
            content: providerResponse.text,
          });
        }
        messages.push({
          role: 'user',
          content: buildPlannerForcedFinishUserPrompt(
            'Current evidence is already repeating and likely sufficient. Produce your final answer now.'
          ),
        });
        debugRecorder.record({
          kind: 'planner_forced_finish_reprompt',
          attemptsRemaining: forcedFinishAttemptsRemaining,
        });
        if (forcedFinishAttemptsRemaining === 0) {
          debugRecorder.finish({
            status: 'failed',
            reason: 'planner_forced_finish_attempt_limit',
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

      countToolTokens = true;

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
        result = executePlannerTool(options.inputText, action, allowedTools);
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
      const rawFormattedResultText = formatPlannerResult(result);
      const formattedResultText = buildPromptToolResult({
        toolName: action.tool_name,
        rawOutput: rawFormattedResultText,
      });
      const remainingPromptTokens = Math.max(promptBudget.plannerStopLineTokens - promptTokenCount, 0);
      const rawResultTokenCount = (
        await countLlamaCppTokens(options.config, rawFormattedResultText)
      ) ?? estimatePromptTokenCount(options.config, rawFormattedResultText);
      const normalizedRawResultTokenCount = Math.max(0, Math.ceil(rawResultTokenCount));
      const resultTokenCount = (
        await countLlamaCppTokens(options.config, formattedResultText)
      ) ?? estimatePromptTokenCount(options.config, formattedResultText);
      const normalizedResultTokenCount = Math.max(0, Math.ceil(resultTokenCount));
      const promptResultText = normalizedResultTokenCount > (remainingPromptTokens * 0.7)
        ? formatPlannerToolResultTokenGuardError(normalizedResultTokenCount)
        : formattedResultText;
      const exactToolResultTokenCount = await countLlamaCppTokens(options.config, promptResultText);
      const resolvedToolResultTokenCount = exactToolResultTokenCount ?? estimatePromptTokenCount(options.config, promptResultText);
      const readLineCount = action.tool_name === 'read_lines' && Number.isFinite((result as { lineCount?: unknown }).lineCount)
        ? Number((result as { lineCount?: unknown }).lineCount)
        : 0;
      toolStatsPayload = {
        [action.tool_name]: {
          ...createEmptyToolTypeStats(),
          calls: 1,
          outputCharsTotal: promptResultText.length,
          outputTokensTotal: Math.max(0, Math.ceil(resolvedToolResultTokenCount)),
          outputTokensEstimatedCount: exactToolResultTokenCount === null ? 1 : 0,
          lineReadCalls: readLineCount > 0 ? 1 : 0,
          lineReadLinesTotal: readLineCount,
          lineReadTokensTotal: readLineCount > 0 ? normalizedRawResultTokenCount : 0,
          promptInsertedTokens: Math.max(0, Math.ceil(resolvedToolResultTokenCount)),
          rawToolResultTokens: normalizedRawResultTokenCount,
        },
      };
      const novelty = classifyToolResultNovelty({
        promptResultText,
        recentEvidenceKeys,
      });
      const fingerprint = fingerprintToolCall({
        toolName: action.tool_name,
        args: action.args,
      });
      for (const evidenceKey of novelty.evidenceKeys) {
        recentEvidenceKeys.add(evidenceKey);
      }
      toolStatsPayload[action.tool_name].newEvidenceCalls = novelty.hasNewEvidence ? 1 : 0;
      toolStatsPayload[action.tool_name].noNewEvidenceCalls = novelty.hasNewEvidence ? 0 : 1;
      if (lastSuccessfulFingerprint && lastSuccessfulFingerprint === fingerprint) {
        consecutiveSemanticRepeats += 1;
        messages.push({
          role: 'user',
          content: 'That tool call repeats the same search intent and is unlikely to add new evidence. Change strategy or finish now.',
        });
        toolStatsPayload[action.tool_name].semanticRepeatRejects = 1;
        debugRecorder.record({
          kind: 'planner_semantic_repeat',
          toolCall: action,
          fingerprint,
          repeats: consecutiveSemanticRepeats,
        });
        if (consecutiveSemanticRepeats >= 2 && forcedFinishAttemptsRemaining === 0) {
          forcedFinishAttemptsRemaining = PLANNER_FORCED_FINISH_MAX_ATTEMPTS;
          messages.push({
            role: 'user',
            content: buildPlannerForcedFinishUserPrompt(
              'Current evidence is already repeating and likely sufficient. Produce your final answer now.'
            ),
          });
          toolStatsPayload[action.tool_name].forcedFinishFromStagnation = 1;
        }
      } else {
        consecutiveSemanticRepeats = 0;
      }
      lastSuccessfulFingerprint = fingerprint;
      consecutiveNoNewEvidence = novelty.hasNewEvidence ? 0 : (consecutiveNoNewEvidence + 1);
      const toolCallId = `call_${toolResults.length + 1}`;
      let appendReplayMessages = true;
      const replayFingerprint = buildToolReplayFingerprint({
        toolName: action.tool_name,
        promptResultText,
      });
      if (novelty.hasNewEvidence) {
        lastReplayFingerprint = replayFingerprint;
        replayRepeatCount = 1;
        lastReplayToolMessageIndex = messages.length + 1;
      } else if (lastReplayFingerprint === replayFingerprint) {
        replayRepeatCount += 1;
        const summary = buildRepeatedToolCallSummary(action.tool_name, replayRepeatCount);
        if (lastReplayToolMessageIndex >= 0 && lastReplayToolMessageIndex < messages.length) {
          const previousToolMessage = messages[lastReplayToolMessageIndex];
          messages[lastReplayToolMessageIndex] = {
            role: 'tool',
            tool_call_id: previousToolMessage?.tool_call_id,
            content: summary,
          };
          appendReplayMessages = false;
        }
      } else {
        lastReplayFingerprint = replayFingerprint;
        replayRepeatCount = 1;
        lastReplayToolMessageIndex = messages.length + 1;
      }

      if (replayRepeatCount === PLANNER_STAGNATION_WARNING_THRESHOLD) {
        messages.push({
          role: 'user',
          content: 'Repeated tool output x3. Use a different command now or you will be forced to answer.',
        });
        if (toolStatsPayload[action.tool_name]) {
          toolStatsPayload[action.tool_name].stagnationWarnings = 1;
        }
      }
      if (replayRepeatCount >= PLANNER_STAGNATION_FORCE_THRESHOLD && forcedFinishAttemptsRemaining === 0) {
        forcedFinishAttemptsRemaining = PLANNER_FORCED_FINISH_MAX_ATTEMPTS;
        messages.push({
          role: 'user',
          content: buildPlannerForcedFinishUserPrompt(
            'You repeated the same tool output too many times. Produce your final answer now.'
          ),
        });
        if (toolStatsPayload[action.tool_name]) {
          toolStatsPayload[action.tool_name].forcedFinishFromStagnation = 1;
        }
      }

      if (appendReplayMessages) {
        messages.push(buildPlannerAssistantToolMessage(action, toolCallId));
        messages.push({
          role: 'tool',
          tool_call_id: toolCallId,
          content: promptResultText,
        });
      }
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
        taskKind: 'summary',
        requestId: options.requestId,
        promptCharacterCount: prompt.length,
        inputTokens: providerResponse.inputTokens,
        outputCharacterCount: providerResponse.outputCharacterCount,
        outputTokens: countOutputTokens ? providerResponse.outputTokens : null,
        toolTokens: countToolTokens ? providerResponse.outputTokens : null,
        thinkingTokens: providerResponse.thinkingTokens,
        toolStats: toolStatsPayload,
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

import type { SiftConfig } from '../../config/index.js';
import {
  createEmptyToolTypeStats,
} from '../../line-read-guidance.js';
import {
  countLlamaCppTokens,
  type CountLlamaCppTokensOptions,
  type LlamaCppChatMessage,
} from '../../providers/llama-cpp.js';
import { getErrorMessage } from '../../lib/errors.js';
import { ModelJson } from '../../lib/model-json.js';
import {
  buildConservativeDirectFallbackDecision,
  normalizeStructuredDecision,
} from '../structured.js';
import {
  buildPlannerToolDefinitions,
  executePlannerTool,
  formatPlannerResult,
  formatPlannerToolResultHeader,
} from './tools.js';
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
import type { TemporaryTimingRecorder } from '../../lib/temporary-timing-recorder.js';
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
import {
  appendToolCallExchange,
  appendToolBatchExchange,
  upsertTrailingUserMessage,
  type ToolBatchOutcome,
  type ToolTranscriptAction,
} from '../../tool-call-messages.js';
import {
  findContiguousUnreadRange,
  ToolOutputFitter,
  type ToolOutputTruncationUnit,
} from '../../tool-output-fit.js';

const MAX_PLANNER_TOOL_CALLS = 30;
const PLANNER_FORCED_FINISH_MAX_ATTEMPTS = 2;
const PLANNER_DUPLICATE_FORCE_THRESHOLD = 5;
// How many malformed model replies the planner tolerates before giving up.
// A couple of garbled responses should not abort a whole large-input request;
// each invalid reply is fed back with corrective guidance before retrying.
const MAX_PLANNER_INVALID_RESPONSES = 4;

function getPlannerTokenizeOptions(requestTimeoutSeconds: number | undefined): CountLlamaCppTokensOptions | undefined {
  const timeoutSeconds = Number(requestTimeoutSeconds);
  if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) {
    return undefined;
  }
  const timeoutMs = Math.max(1, Math.trunc(timeoutSeconds * 1000));
  return {
    timeoutMs,
    retryMaxWaitMs: timeoutMs,
  };
}

function tryParseSummaryDecision(providerText: string): StructuredModelDecision | null {
  try {
    return ModelJson.parseSummaryDecision(providerText);
  } catch {
    return null;
  }
}

function buildPlannerInvalidToolAction(providerText: string): ToolTranscriptAction {
  try {
    const recoveredAction = ModelJson.parseSummaryPlannerAction(providerText);
    if (recoveredAction.action === 'tool') {
      return recoveredAction;
    }
    if (recoveredAction.action === 'tool_batch') {
      const firstToolCall = recoveredAction.tool_calls[0];
      if (firstToolCall) {
        return {
          tool_name: firstToolCall.tool_name,
          args: firstToolCall.args,
        };
      }
    }
  } catch {
    // Invalid responses are fed back to the model as an explicit invalid tool call.
  }
  return {
    tool_name: 'invalid_tool_call',
    args: {
      rawResponseText: String(providerText || '').trim(),
    },
  };
}

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
  statusBackendUrl?: string | null;
  timingRecorder?: TemporaryTimingRecorder | null;
}): Promise<StructuredModelDecision | null> {
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
  let forcedFinishAttemptsRemaining = 0;
  let consecutiveNoNewEvidence = 0;
  let lastSuccessfulFingerprint: string | null = null;
  const recentEvidenceKeys = new Set<string>();
  let duplicateReplayFingerprint: string | null = null;
  let duplicateReplayCount = 0;
  let duplicateReplayToolMessageIndex = -1;
  let forcedFinishCountdownUserMessageIndex = -1;
  let lastSuccessfulReadLinesArgsText: string | null = null;
  const tokenizeOptions = getPlannerTokenizeOptions(options.requestTimeoutSeconds);
  const inputLines = options.inputText.replace(/\r\n/gu, '\n').split('\n');
  const readLinesReturnedRanges: Array<{ start: number; end: number }> = [];

  while (toolResults.length <= MAX_PLANNER_TOOL_CALLS) {
    const turn = toolResults.length + 1;
    const promptRenderSpan = options.timingRecorder?.start('summary.planner.prompt.render', {
      turn,
      messageCount: messages.length,
    });
    const prompt = renderPlannerTranscript(messages);
    promptRenderSpan?.end({ promptChars: prompt.length });
    const promptTokenSpan = options.timingRecorder?.start('summary.planner.prompt.tokenize', {
      turn,
      promptChars: prompt.length,
    });
    const promptTokenCount = (
      await countLlamaCppTokens(options.config, prompt, tokenizeOptions)
    ) ?? estimatePromptTokenCount(options.config, prompt);
    promptTokenSpan?.end({ promptTokenCount });
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
      providerDurationMs: number;
      statusRunningMs: number;
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
        requestTimeoutSeconds: options.requestTimeoutSeconds,
        llamaCppOverrides: options.llamaCppOverrides,
        statusBackendUrl: options.statusBackendUrl,
        timingRecorder: options.timingRecorder || null,
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
        const parseSpan = options.timingRecorder?.start('summary.planner.response.parse', {
          turn,
          responseChars: providerResponse.text.length,
        });
        try {
          action = ModelJson.parseSummaryPlannerAction(providerResponse.text);
          parseSpan?.end({ ok: true });
        } catch (error) {
          parseSpan?.end({ ok: false });
          throw error;
        }
      } catch (error) {
        const recoveredDecision = toolResults.length === 0
          ? tryParseSummaryDecision(providerResponse.text)
          : null;
        if (recoveredDecision) {
          const decision = normalizeStructuredDecision(recoveredDecision, options.format);
          debugRecorder.finish({
            status: 'completed',
            command: options.debugCommand ?? null,
            finalOutput: decision.output,
            classification: decision.classification,
            rawReviewRequired: decision.rawReviewRequired,
          });
          return decision;
        }
        invalidActionCount += 1;
        const invalidResponseError = getErrorMessage(error);
        const invalidToolResultText = buildPlannerInvalidResponseUserPrompt(invalidResponseError);
        appendToolCallExchange(
          messages,
          buildPlannerInvalidToolAction(providerResponse.text),
          `invalid_call_${invalidActionCount}`,
          invalidToolResultText,
          providerResponse.reasoningText || '',
        );
        debugRecorder.record({
          kind: 'planner_invalid_response',
          error: invalidResponseError,
          toolResultText: invalidToolResultText,
        });
        if (invalidActionCount >= MAX_PLANNER_INVALID_RESPONSES) {
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

      countToolTokens = true;

      const toolActions = action.action === 'tool_batch'
        ? action.tool_calls.map((toolCall) => ({
          action: 'tool' as const,
          tool_name: toolCall.tool_name,
          args: toolCall.args,
        }))
        : [action];

      if (forcedFinishAttemptsRemaining > 0) {
        forcedFinishAttemptsRemaining = Math.max(forcedFinishAttemptsRemaining - 1, 0);
        const rejectedToolAction = toolActions[0];
        const forcedToolResultText = buildPlannerForcedFinishUserPrompt(
          'Current evidence is already repeating and likely sufficient. Produce your final answer now.'
        );
        appendToolCallExchange(
          messages,
          rejectedToolAction,
          `forced_finish_call_${toolResults.length + 1}`,
          forcedToolResultText,
          providerResponse.reasoningText || '',
        );
        forcedFinishCountdownUserMessageIndex = upsertTrailingUserMessage(
          messages,
          forcedFinishCountdownUserMessageIndex,
          `Forced finish attempts remaining: ${forcedFinishAttemptsRemaining}. Produce your final answer now.`,
        );
        debugRecorder.record({
          kind: 'planner_forced_finish_reprompt',
          attemptsRemaining: forcedFinishAttemptsRemaining,
          toolCall: rejectedToolAction,
          toolResultText: forcedToolResultText,
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

      if ((toolResults.length + toolActions.length) > MAX_PLANNER_TOOL_CALLS) {
        debugRecorder.record({
          kind: 'planner_forced_finish',
          reason: 'planner_tool_call_limit',
          toolCallCount: toolResults.length,
        });
        const limitedToolAction = toolActions[0];
        appendToolCallExchange(
          messages,
          limitedToolAction,
          `tool_limit_call_${toolResults.length + 1}`,
          buildPlannerForcedFinishUserPrompt(),
          providerResponse.reasoningText || '',
        );
        messages.push({
          role: 'user',
          content: buildPlannerForcedFinishUserPrompt(),
        });
        try {
          const forcedPrompt = renderPlannerTranscript(messages);
          const forcedPromptTokenSpan = options.timingRecorder?.start('summary.planner.prompt.tokenize_forced', {
            turn,
            promptChars: forcedPrompt.length,
          });
          const forcedPromptTokenCount = (
            await countLlamaCppTokens(options.config, forcedPrompt, tokenizeOptions)
          ) ?? estimatePromptTokenCount(options.config, forcedPrompt);
          forcedPromptTokenSpan?.end({ promptTokenCount: forcedPromptTokenCount });
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
            statusBackendUrl: options.statusBackendUrl,
            timingRecorder: options.timingRecorder || null,
          });
          const forcedAction = ModelJson.parseSummaryPlannerAction(forcedResponse.text);
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

      const batchOutcomes: ToolBatchOutcome[] = [];
      const pendingModeChangeUserMessages: string[] = [];
      let batchDuplicateAnchorIndex: number | null = null;

      for (const toolAction of toolActions) {
        const fingerprint = fingerprintToolCall({
          toolName: toolAction.tool_name,
          args: toolAction.args,
        });
        const readLinesExactRepeat = toolAction.tool_name === 'read_lines'
          && lastSuccessfulReadLinesArgsText === JSON.stringify(toolAction.args);
        if (!readLinesExactRepeat && lastSuccessfulFingerprint && lastSuccessfulFingerprint === fingerprint) {
          const isActiveDuplicate = duplicateReplayFingerprint === fingerprint
            && duplicateReplayToolMessageIndex >= 0
            && duplicateReplayToolMessageIndex < messages.length;
          duplicateReplayFingerprint = fingerprint;
          duplicateReplayCount = isActiveDuplicate ? (duplicateReplayCount + 1) : 2;
          const duplicateSummary = buildRepeatedToolCallSummary(toolAction.tool_name, duplicateReplayCount);
          if (isActiveDuplicate) {
            const previousToolMessage = messages[duplicateReplayToolMessageIndex];
            messages[duplicateReplayToolMessageIndex] = {
              role: 'tool',
              tool_call_id: previousToolMessage?.tool_call_id,
              content: duplicateSummary,
            };
          } else {
            const duplicateToolCallId = `duplicate_call_${toolResults.length + 1}`;
            batchOutcomes.push({
              action: toolAction,
              toolCallId: duplicateToolCallId,
              toolContent: duplicateSummary,
            });
            batchDuplicateAnchorIndex = batchOutcomes.length - 1;
          }
          toolStatsPayload ||= {};
          const duplicateToolStats = toolStatsPayload[toolAction.tool_name] || createEmptyToolTypeStats();
          toolStatsPayload[toolAction.tool_name] = {
            ...duplicateToolStats,
            semanticRepeatRejects: duplicateToolStats.semanticRepeatRejects + 1,
          };
          debugRecorder.record({
            kind: 'planner_semantic_repeat',
            toolCall: toolAction,
            fingerprint,
            repeats: duplicateReplayCount,
          });
          if (duplicateReplayCount >= PLANNER_DUPLICATE_FORCE_THRESHOLD && forcedFinishAttemptsRemaining === 0) {
            forcedFinishAttemptsRemaining = PLANNER_FORCED_FINISH_MAX_ATTEMPTS;
            pendingModeChangeUserMessages.push(
              buildPlannerForcedFinishUserPrompt(
                'You repeated the same tool call too many times. Produce your final answer now.'
              ),
            );
            toolStatsPayload[toolAction.tool_name] = {
              ...toolStatsPayload[toolAction.tool_name],
              forcedFinishFromStagnation: toolStatsPayload[toolAction.tool_name].forcedFinishFromStagnation + 1,
            };
          }
          continue;
        }

        let effectiveToolAction = toolAction;
        let readLinesNoUnread = false;
        if (toolAction.tool_name === 'read_lines') {
          const requestedStart = Math.max(1, Math.trunc(Number(toolAction.args.startLine) || 1));
          const requestedEnd = Math.max(requestedStart, Math.trunc(Number(toolAction.args.endLine) || requestedStart));
          const requestedEndExclusive = Math.min(requestedEnd + 1, inputLines.length + 1);
          const hasReturnedRanges = readLinesReturnedRanges.length > 0;
          const unreadRange = findContiguousUnreadRange({
            requestedStart: Math.min(requestedStart, inputLines.length || 1),
            totalEnd: hasReturnedRanges ? inputLines.length + 1 : requestedEndExclusive,
            returnedRanges: readLinesReturnedRanges,
          });
          readLinesNoUnread = !unreadRange.hasUnread;
          effectiveToolAction = {
            ...toolAction,
            args: unreadRange.hasUnread
              ? { ...toolAction.args, startLine: unreadRange.start, endLine: unreadRange.end - 1 }
              : { ...toolAction.args, startLine: unreadRange.start, endLine: unreadRange.end },
          };
        }

        let result: Record<string, unknown>;
        const toolExecutionSpan = options.timingRecorder?.start('summary.planner.tool.execute', {
          turn,
          toolName: effectiveToolAction.tool_name,
        });
        try {
          if (effectiveToolAction.tool_name === 'read_lines' && readLinesNoUnread) {
            result = {
              tool: 'read_lines',
              startLine: effectiveToolAction.args.startLine,
              endLine: effectiveToolAction.args.endLine,
              lineCount: 0,
              text: 'No unread lines remain for input text.',
            };
          } else {
            result = executePlannerTool(options.inputText, effectiveToolAction, allowedTools);
          }
          toolExecutionSpan?.end({ ok: true });
        } catch (error) {
          toolExecutionSpan?.end({ ok: false });
          invalidActionCount += 1;
          const invalidResponseError = getErrorMessage(error);
          const invalidToolResultText = buildPlannerInvalidResponseUserPrompt(invalidResponseError);
          batchOutcomes.push({
            action: toolAction,
            toolCallId: `invalid_call_${invalidActionCount}`,
            toolContent: invalidToolResultText,
          });
          debugRecorder.record({
            kind: 'planner_invalid_response',
            error: invalidResponseError,
            toolCall: toolAction,
            toolResultText: invalidToolResultText,
          });
          if (invalidActionCount >= MAX_PLANNER_INVALID_RESPONSES) {
            appendToolBatchExchange(messages, batchOutcomes, providerResponse.reasoningText || '');
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
          command: `${toolAction.tool_name} ${JSON.stringify(toolAction.args)}`,
          toolName: toolAction.tool_name,
          args: toolAction.args,
          output: result,
        });
        const formatSpan = options.timingRecorder?.start('summary.planner.tool.format', {
          turn,
          toolName: toolAction.tool_name,
        });
        const rawFormattedResultText = formatPlannerResult(result);
        const formattedResultText = buildPromptToolResult({
          toolName: effectiveToolAction.tool_name,
          rawOutput: rawFormattedResultText,
        });
        formatSpan?.end({
          rawChars: rawFormattedResultText.length,
          formattedChars: formattedResultText.length,
        });
        const remainingPromptTokens = Math.max(promptBudget.plannerStopLineTokens - promptTokenCount, 0);
        const rawTokenSpan = options.timingRecorder?.start('summary.planner.tool.tokenize_raw', {
          turn,
          toolName: toolAction.tool_name,
          inputChars: rawFormattedResultText.length,
        });
        const rawResultTokenCount = (
          await countLlamaCppTokens(options.config, rawFormattedResultText, tokenizeOptions)
        ) ?? estimatePromptTokenCount(options.config, rawFormattedResultText);
        rawTokenSpan?.end({ tokenCount: rawResultTokenCount });
        const normalizedRawResultTokenCount = Math.max(0, Math.ceil(rawResultTokenCount));
        const formattedTokenSpan = options.timingRecorder?.start('summary.planner.tool.tokenize_formatted', {
          turn,
          toolName: toolAction.tool_name,
          inputChars: formattedResultText.length,
        });
        const formattedTokenCountRaw = await countLlamaCppTokens(options.config, formattedResultText, tokenizeOptions);
        const formattedTokenCountEstimated = formattedTokenCountRaw === null;
        const resultTokenCount = formattedTokenCountRaw ?? estimatePromptTokenCount(options.config, formattedResultText);
        formattedTokenSpan?.end({ tokenCount: resultTokenCount });
        const normalizedResultTokenCount = Math.max(0, Math.ceil(resultTokenCount));

        let promptResultText: string;
        let resolvedToolResultTokenCount: number;
        let toolResultTokenEstimated: boolean;
        if (normalizedResultTokenCount > (remainingPromptTokens * 0.7)) {
          const headerText = formatPlannerToolResultHeader(result);
          const resultBodyText = typeof result.text === 'string' ? result.text : formattedResultText;
          const unit: ToolOutputTruncationUnit = effectiveToolAction.tool_name === 'find_text' ? 'results' : 'lines';
          const separator = effectiveToolAction.tool_name === 'find_text' ? '\n\n' : '\n';
          const segments = effectiveToolAction.tool_name === 'find_text'
            ? resultBodyText.split(/\n\s*\n/u).filter((segment) => segment.trim().length > 0)
            : resultBodyText.split(/\r?\n/u).filter((line) => line.length > 0);
          const fitter = new ToolOutputFitter({
            async countToolOutputTokens(textToCount: string): Promise<number> {
              const tokenCountRaw = await countLlamaCppTokens(options.config, textToCount, tokenizeOptions);
              return tokenCountRaw ?? estimatePromptTokenCount(options.config, textToCount);
            },
          });
          const fitResult = await fitter.fitSegments({
            headerText: headerText || undefined,
            segments,
            separator,
            maxTokens: Math.max(1, Math.floor(remainingPromptTokens * 0.7)),
            unit,
          });
          promptResultText = buildPromptToolResult({
            toolName: effectiveToolAction.tool_name,
            rawOutput: fitResult.visibleText,
          });
          const fitTokenSpan = options.timingRecorder?.start('summary.planner.tool.tokenize_prompt', {
            turn,
            toolName: effectiveToolAction.tool_name,
            inputChars: promptResultText.length,
          });
          const fitTokenCountRaw = await countLlamaCppTokens(options.config, promptResultText, tokenizeOptions);
          fitTokenSpan?.end({ tokenCount: fitTokenCountRaw ?? -1 });
          toolResultTokenEstimated = fitTokenCountRaw === null;
          resolvedToolResultTokenCount = fitTokenCountRaw ?? estimatePromptTokenCount(options.config, promptResultText);
        } else {
          promptResultText = formattedResultText;
          toolResultTokenEstimated = formattedTokenCountEstimated;
          resolvedToolResultTokenCount = resultTokenCount;
        }
        const readLineCount = toolAction.tool_name === 'read_lines' && Number.isFinite((result as { lineCount?: unknown }).lineCount)
          ? Number((result as { lineCount?: unknown }).lineCount)
          : 0;
        toolStatsPayload ||= {};
        const currentToolStats = toolStatsPayload[toolAction.tool_name] || createEmptyToolTypeStats();
        toolStatsPayload[toolAction.tool_name] = {
          ...currentToolStats,
          calls: currentToolStats.calls + 1,
          outputCharsTotal: currentToolStats.outputCharsTotal + promptResultText.length,
          outputTokensTotal: currentToolStats.outputTokensTotal + Math.max(0, Math.ceil(resolvedToolResultTokenCount)),
          outputTokensEstimatedCount: currentToolStats.outputTokensEstimatedCount + (toolResultTokenEstimated ? 1 : 0),
          lineReadCalls: currentToolStats.lineReadCalls + (readLineCount > 0 ? 1 : 0),
          lineReadLinesTotal: currentToolStats.lineReadLinesTotal + readLineCount,
          lineReadTokensTotal: currentToolStats.lineReadTokensTotal + (readLineCount > 0 ? normalizedRawResultTokenCount : 0),
          promptInsertedTokens: currentToolStats.promptInsertedTokens + Math.max(0, Math.ceil(resolvedToolResultTokenCount)),
          rawToolResultTokens: currentToolStats.rawToolResultTokens + normalizedRawResultTokenCount,
        };
        const novelty = classifyToolResultNovelty({
          promptResultText,
          recentEvidenceKeys,
        });
        for (const evidenceKey of novelty.evidenceKeys) {
          recentEvidenceKeys.add(evidenceKey);
        }
        if (effectiveToolAction.tool_name === 'read_lines') {
          const returnedLineCount = promptResultText.split(/\r?\n/u).filter((line) => /^\d+:/u.test(line)).length;
          const returnedStartLine = Math.max(1, Math.trunc(Number(result.startLine) || 1));
          if (returnedLineCount > 0) {
            readLinesReturnedRanges.push({
              start: returnedStartLine,
              end: returnedStartLine + returnedLineCount,
            });
          }
        }
        toolStatsPayload[toolAction.tool_name].newEvidenceCalls += novelty.hasNewEvidence ? 1 : 0;
        toolStatsPayload[toolAction.tool_name].noNewEvidenceCalls += novelty.hasNewEvidence ? 0 : 1;
        duplicateReplayFingerprint = null;
        duplicateReplayCount = 0;
        duplicateReplayToolMessageIndex = -1;
        lastSuccessfulFingerprint = fingerprint;
        lastSuccessfulReadLinesArgsText = effectiveToolAction.tool_name === 'read_lines'
          ? JSON.stringify(toolAction.args)
          : null;
        consecutiveNoNewEvidence = novelty.hasNewEvidence ? 0 : (consecutiveNoNewEvidence + 1);
        const toolCallId = `call_${toolResults.length + 1}`;
        batchOutcomes.push({
          action: effectiveToolAction,
          toolCallId,
          toolContent: promptResultText,
        });
        toolResults.push({
          toolName: effectiveToolAction.tool_name,
          args: effectiveToolAction.args,
          result,
          resultText: promptResultText,
        });
      }

      const preAppendMessagesLength = messages.length;
      const appendSpan = options.timingRecorder?.start('summary.planner.tool.append', {
        turn,
        outcomeCount: batchOutcomes.length,
        beforeMessageCount: messages.length,
      });
      appendToolBatchExchange(messages, batchOutcomes, providerResponse.reasoningText || '');
      appendSpan?.end({ afterMessageCount: messages.length });
      if (batchDuplicateAnchorIndex !== null && batchOutcomes.length > 0) {
        duplicateReplayToolMessageIndex = preAppendMessagesLength + 1 + batchDuplicateAnchorIndex;
      }
      for (const userMessage of pendingModeChangeUserMessages) {
        messages.push({ role: 'user', content: userMessage });
      }
    } finally {
      traceSummary(`notify running=false phase=planner chunk=none duration_ms=${providerResponse.requestDurationMs}`);
      const notifyTerminalSpan = options.timingRecorder?.start('summary.planner.status.notify_terminal', {
        terminalState: 'iteration',
      });
      void notifyStatusBackend({
        running: false,
        taskKind: 'summary',
        statusBackendUrl: options.statusBackendUrl,
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
        providerDurationMs: providerResponse.providerDurationMs,
        statusRunningMs: providerResponse.statusRunningMs,
      }).catch(() => {
        notifyTerminalSpan?.end({ ok: false });
        traceSummary(`notify running=false failed phase=planner chunk=none request_id=${options.requestId}`);
      }).then(() => {
        notifyTerminalSpan?.end({ ok: true });
      });
    }
  }

  debugRecorder.finish({
    status: 'failed',
    reason: 'planner_exhausted_without_finish',
  });
  return null;
}

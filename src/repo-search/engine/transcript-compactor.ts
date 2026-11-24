import type { SiftConfig } from '../../config/index.ts';
import {
  compactionRequestShape,
  requestContextCompactionSummary,
  type CompactionCacheOrigin,
} from '../planner-protocol.ts';
import { findPlannerContextViolation, type ChatMessage } from '../planner-chat-message.ts';
import { buildCompactionSummaryInstruction } from '../prompts.ts';
import { countPlannerPromptTokens, countTokensWithFallback } from '../prompt-budget.ts';
import { renderWirePrompt } from '../wire-prompt.ts';
import type { JsonLogger } from '../types.ts';
import type { InferenceActivityObserver } from '../../lib/progress-writer.ts';
import { TokenUsageTracker } from './token-usage.ts';
import type { MockPlannerResponseInput } from '../../planner-protocol/mock-response.ts';
import type { ThroughputAuditOperation } from '@siftkit/contracts';
import { toError } from '../../lib/errors.ts';
import { ProviderContextLengthError } from '../../llm-protocol/stream-errors.ts';
import {
  COMPACTION_SUMMARY_MIN_OUTPUT_TOKENS,
  COMPACTION_WINDOW_MARGIN_TOKENS,
  splitCompactionGenerationTokens,
} from './turn-budget.ts';

/** Marks the rebuilt assistant message so the model reads it as history, not as its own answer. */
export const COMPACTION_SUMMARY_MARKER = '[CONTEXT COMPACTED — SUMMARY OF PRIOR CONVERSATION]';

/** One backend hiccup is worth retrying; a second identical failure is a real failure. */
const COMPACTION_SUMMARY_ATTEMPTS = 2;

type SummaryGenerationTokens = ReturnType<typeof splitCompactionGenerationTokens>;

/** What the window leaves a summary request; `fullOutput` is false when the output share had to shrink. */
type SummaryFit = { generationTokens: SummaryGenerationTokens; fullOutput: boolean; promptTokenCount: number; remainingTokens: number };

function hasReasoningContent(message: ChatMessage): boolean {
  return typeof message.reasoning_content === 'string' && message.reasoning_content.trim().length > 0;
}

function withoutReasoningContent(message: ChatMessage): ChatMessage {
  const { reasoning_content: _reasoningContent, ...rest } = message;
  return rest;
}

/** The planner's tools and flags without its cache prefix: a request whose history differs opens a new epoch. */
function newEpochOrigin(origin: CompactionCacheOrigin): CompactionCacheOrigin {
  const { flags, tools } = compactionRequestShape(origin);
  return { kind: 'new_epoch', flags, tools };
}

/** A provider rejection of the request's size, which an identical retry would only repeat. */
function isContextLengthRejection(error: Error): boolean {
  return error instanceof ProviderContextLengthError || error.cause instanceof ProviderContextLengthError;
}

/** Which messages survive the compaction, decided by the caller, never by the compactor. */
export type CompactionRetention =
  | { kind: 'current_chat_turn'; startIndex: number }
  | { kind: 'latest_user' }
  | { kind: 'none' };

export type CompactionInput = {
  taskId: string;
  /** The loop turn that overflowed, or null when the caller is not a loop at all. */
  turn: number | null;
  messages: readonly ChatMessage[];
  mockResponseIndex: number;
  retention: CompactionRetention;
  cacheOrigin: CompactionCacheOrigin;
};

/** Replaces an over-budget transcript with a shorter one that still lets the run continue. */
export interface TranscriptCompaction {
  compact(input: CompactionInput): Promise<CompactionOutcome>;
}

export type CompactionOutcome = {
  messages: ChatMessage[];
  summaryText: string;
  droppedMessageCount: number;
  summaryTokenCount: number;
  summaryGenerationTokenBudget: number;
  summaryReasoningTokenBudget: number;
  summaryOutputTokenBudget: number;
  summarizerElapsedMs: number;
  nextMockResponseIndex: number;
  /** First message of the retained in-flight turn in the rebuilt transcript, or null when none is retained. */
  currentTurnStartIndex: number | null;
  promptCacheTokens: number | null;
  promptEvalTokens: number | null;
};

export function writePromptCacheEpochReset(
  logger: JsonLogger | null,
  fields: {
    taskId: string;
    turn: number | null;
    droppedMessageCount: number;
  },
): void {
  logger?.write({
    kind: 'prompt_cache_epoch_reset',
    taskId: fields.taskId,
    turn: fields.turn,
    reason: 'context_compaction',
    droppedMessageCount: fields.droppedMessageCount,
  });
}

/** The assistant message the rebuilt transcript carries in place of the dropped history. */
export function buildCompactionSummaryMessage(summaryText: string): ChatMessage {
  return { role: 'assistant', content: `${COMPACTION_SUMMARY_MARKER}\n${summaryText}` };
}

/**
 * Replaces an over-budget transcript with one LLM-written summary of it. The rebuilt
 * transcript is `system → summary → retained messages`; what is retained is the caller's
 * retention policy, so the summary request is what decides whether the run can still resume.
 */
export class TranscriptCompactor implements TranscriptCompaction {
  private readonly options: {
    config: SiftConfig;
    baseUrl: string;
    model: string;
    timeoutMs: number;
    totalContextTokens: number;
    compactionReserveTokens: number;
    useEstimatedTokensOnly: boolean;
    mockResponses: MockPlannerResponseInput[] | undefined;
    tokenUsage: TokenUsageTracker;
    logger: JsonLogger | null;
    abortSignal: AbortSignal | undefined;
    activityObserver?: InferenceActivityObserver;
    throughputAudit: ThroughputAuditOperation;
  };

  constructor(options: {
    config: SiftConfig;
    baseUrl: string;
    model: string;
    timeoutMs: number;
    totalContextTokens: number;
    compactionReserveTokens: number;
    useEstimatedTokensOnly: boolean;
    mockResponses: MockPlannerResponseInput[] | undefined;
    tokenUsage: TokenUsageTracker;
    logger: JsonLogger | null;
    abortSignal: AbortSignal | undefined;
    activityObserver?: InferenceActivityObserver;
    throughputAudit: ThroughputAuditOperation;
  }) {
    this.options = options;
  }

  private get tokenCountConfig(): SiftConfig | undefined {
    return this.options.useEstimatedTokensOnly ? undefined : this.options.config;
  }

  async compact(input: CompactionInput): Promise<CompactionOutcome> {
    const messages = [...input.messages];
    const systemMessage = String(messages[0]?.role || '') === 'system' ? messages[0] : null;
    const bodyStart = systemMessage ? 1 : 0;
    const partition = partitionCompactionRetention(messages, bodyStart, input.retention);
    const instruction = buildCompactionSummaryInstruction();
    const historyMessages: ChatMessage[] = [
      ...(systemMessage ? [systemMessage] : []),
      ...partition.completedMessages,
    ];
    const instructionMessage: ChatMessage = { role: 'user', content: instruction };
    let summaryHistory = historyMessages;
    let summaryInput = input;
    let fit = await this.fitSummaryGeneration(input, [...summaryHistory, instructionMessage]);
    // Kept reasoning is what overfills the window; the summary needs the decisions, not the thinking behind them.
    if (!fit.fullOutput && summaryHistory.some(hasReasoningContent)) {
      const beforePromptTokenCount = fit.promptTokenCount;
      summaryHistory = summaryHistory.map(withoutReasoningContent);
      summaryInput = { ...input, cacheOrigin: newEpochOrigin(input.cacheOrigin) };
      fit = await this.fitSummaryGeneration(summaryInput, [...summaryHistory, instructionMessage]);
      this.options.logger?.write({ kind: 'turn_compaction_reasoning_dropped', taskId: input.taskId, turn: input.turn,
        beforePromptTokenCount, afterPromptTokenCount: fit.promptTokenCount });
    }
    const generationTokens = this.requireSummaryFit(input, fit);

    const summary = await this.requestSummary(summaryInput, summaryHistory, instruction, generationTokens);
    const rebuilt: ChatMessage[] = [
      ...(systemMessage ? [systemMessage] : []),
      buildCompactionSummaryMessage(summary.summaryText),
      ...partition.retainedMessages,
    ];
    // A retention boundary that cut a tool batch in half would leave the model an answer to a call
    // it cannot see, and a replay of it a transcript no provider accepts. Fail here, not there.
    const violation = findPlannerContextViolation(rebuilt);
    if (violation !== null) {
      throw new Error(`TranscriptCompactor: retention would leave an invalid transcript — ${violation}`);
    }
    const keptMessageCount = (systemMessage ? 1 : 0) + partition.retainedMessages.length;

    return {
      messages: rebuilt,
      summaryText: summary.summaryText,
      droppedMessageCount: messages.length - keptMessageCount,
      summaryTokenCount: await countTokensWithFallback(this.tokenCountConfig, summary.summaryText),
      summaryGenerationTokenBudget: generationTokens.totalTokens,
      summaryReasoningTokenBudget: generationTokens.reasoningTokens,
      summaryOutputTokenBudget: generationTokens.outputTokens,
      summarizerElapsedMs: summary.elapsedMs,
      nextMockResponseIndex: summary.nextMockResponseIndex,
      currentTurnStartIndex: input.retention.kind === 'current_chat_turn' ? (systemMessage ? 2 : 1) : null,
      promptCacheTokens: summary.promptCacheTokens,
      promptEvalTokens: summary.promptEvalTokens,
    };
  }

  /**
   * The summary generation gets what the window leaves after its prompt and a margin, up to the run's response
   * reserve. Two thirds cap thinking; the remaining third is the floor under the summary output, not its cap.
   */
  private async fitSummaryGeneration(
    input: { cacheOrigin: CompactionCacheOrigin },
    summaryRequestMessages: ChatMessage[],
  ): Promise<SummaryFit> {
    const state = compactionRequestShape(input.cacheOrigin);
    const generationTokenCeiling = Math.max(0, Math.floor(this.options.compactionReserveTokens));
    const measurement = await countPlannerPromptTokens({
      config: this.tokenCountConfig,
      prompt: renderWirePrompt({
        messages: summaryRequestMessages,
        tools: state.tools,
        includeReasoningContent: state.flags.reasoningContentEnabled,
      }),
    });
    const promptTokenCount = measurement.promptTokenCount;
    const remainingTokens = this.options.totalContextTokens - promptTokenCount - COMPACTION_WINDOW_MARGIN_TOKENS;
    const requestedTokens = splitCompactionGenerationTokens(generationTokenCeiling);
    const outputTokens = Math.min(requestedTokens.outputTokens, Math.max(remainingTokens, 0));
    const reasoningTokens = Math.min(
      requestedTokens.reasoningTokens,
      Math.max(remainingTokens - outputTokens, 0),
    );
    return {
      generationTokens: { totalTokens: reasoningTokens + outputTokens, reasoningTokens, outputTokens },
      fullOutput: outputTokens >= requestedTokens.outputTokens,
      promptTokenCount,
      remainingTokens,
    };
  }

  /** Below COMPACTION_SUMMARY_MIN_OUTPUT_TOKENS a summary is a stub that loses the conversation, so the run fails loudly. */
  private requireSummaryFit(input: { taskId: string; turn: number | null }, fit: SummaryFit): SummaryGenerationTokens {
    if (fit.generationTokens.outputTokens >= COMPACTION_SUMMARY_MIN_OUTPUT_TOKENS) {
      return fit.generationTokens;
    }
    const message = `planner_compaction_prompt_overflow prompt_tokens=${fit.promptTokenCount} `
      + `remaining_tokens=${fit.remainingTokens} min_summary_output_tokens=${COMPACTION_SUMMARY_MIN_OUTPUT_TOKENS} `
      + `total_context_tokens=${this.options.totalContextTokens} turn=${formatTurn(input.turn)}`;
    this.options.logger?.write({
      kind: 'turn_compaction_prompt_overflow_fail',
      taskId: input.taskId,
      turn: input.turn,
      promptTokenCount: fit.promptTokenCount,
      remainingTokens: fit.remainingTokens,
      minSummaryOutputTokens: COMPACTION_SUMMARY_MIN_OUTPUT_TOKENS,
      totalContextTokens: this.options.totalContextTokens,
      error: message,
    });
    throw new Error(message);
  }

  private async requestSummary(
    input: {
      taskId: string;
      turn: number | null;
      mockResponseIndex: number;
      cacheOrigin: CompactionCacheOrigin;
    },
    historyMessages: ChatMessage[],
    instruction: string,
    generationTokens: SummaryGenerationTokens,
  ): Promise<{
    summaryText: string;
    nextMockResponseIndex: number;
    elapsedMs: number;
    promptCacheTokens: number | null;
    promptEvalTokens: number | null;
  }> {
    let mockResponseIndex = input.mockResponseIndex;
    let lastErrorMessage = '';
    let lastFailure: Error | null = null;
    let attempts = 0;
    // Compaction is part of preparing the turn that overflowed, so its cost belongs to that
    // turn's record. The manual condense path has no planner turn and no token consumer:
    // its tracker is constructed for the single call and discarded, so there is nothing to
    // attribute and no row that could disagree.
    const summaryTurn = input.turn;
    for (let attempt = 1; attempt <= COMPACTION_SUMMARY_ATTEMPTS; attempt += 1) {
      attempts = attempt;
      const startedAt = Date.now();
      try {
        const response = await requestContextCompactionSummary({
          config: this.options.config,
          baseUrl: this.options.baseUrl,
          model: this.options.model,
          throughputAudit: this.options.throughputAudit,
          messages: historyMessages,
          instruction,
          timeoutMs: this.options.timeoutMs,
          maxTokens: generationTokens.totalTokens,
          reasoningBudgetTokens: generationTokens.reasoningTokens,
          continuationMinTokens: generationTokens.outputTokens,
          cacheOrigin: input.cacheOrigin,
          mockResponses: this.options.mockResponses,
          mockResponseIndex,
          abortSignal: this.options.abortSignal,
          logger: this.options.logger,
          activityObserver: this.options.activityObserver,
        });
        if (typeof response.nextMockResponseIndex === 'number') {
          mockResponseIndex = response.nextMockResponseIndex;
        }
        if (summaryTurn !== null) {
          const resolved = await this.options.tokenUsage.recordModelResponse(response, 0, summaryTurn);
          this.options.tokenUsage.addOutputTokens(resolved.completionTokens, summaryTurn, resolved.completionTokensEstimated);
        }
        const summaryText = String(response.text || '').trim();
        if (!response.mockExhausted && summaryText) {
          return {
            summaryText,
            nextMockResponseIndex: mockResponseIndex,
            elapsedMs: Date.now() - startedAt,
            promptCacheTokens: response.promptCacheTokens ?? null,
            promptEvalTokens: response.promptEvalTokens ?? null,
          };
        }
        lastErrorMessage = response.mockExhausted ? 'mock_exhausted' : 'empty_output';
      } catch (error) {
        lastFailure = toError(error);
        lastErrorMessage = lastFailure.message;
        // A context-size rejection repeats exactly on an identical request; fail now instead of resending it.
        if (isContextLengthRejection(lastFailure)) break;
      }
      this.options.logger?.write({
        kind: 'turn_compaction_summary_retry',
        taskId: input.taskId,
        turn: input.turn,
        attempt,
        error: lastErrorMessage,
      });
    }
    throw new Error(
      `planner_compaction_failed attempts=${attempts} turn=${formatTurn(input.turn)} last_error=${lastErrorMessage || 'unknown'}`,
      lastFailure === null ? undefined : { cause: lastFailure },
    );
  }
}

/** A caller outside the turn loop has no turn to name, and must not borrow turn zero. */
function formatTurn(turn: number | null): string {
  return turn === null ? 'none' : String(turn);
}

/**
 * Splits the transcript into the completed history the summarizer sees and the messages
 * that survive the compaction unchanged. The boundary is validated here, before any
 * provider call, so a bad policy fails loudly instead of summarizing the wrong range.
 */
function partitionCompactionRetention(
  messages: readonly ChatMessage[],
  bodyStart: number,
  retention: CompactionRetention,
): { completedMessages: ChatMessage[]; retainedMessages: ChatMessage[] } {
  switch (retention.kind) {
    case 'current_chat_turn': {
      const startIndex = retention.startIndex;
      if (!Number.isInteger(startIndex) || startIndex < bodyStart || startIndex >= messages.length) {
        throw new Error(
          `invalid compaction retention boundary: startIndex ${String(startIndex)} is outside the transcript body [${bodyStart}, ${messages.length})`,
        );
      }
      const retainedMessages = messages.slice(startIndex);
      if (String(retainedMessages[0].role || '') !== 'user') {
        throw new Error('invalid compaction retention boundary: the retained chat turn must begin with a user message');
      }
      return { completedMessages: messages.slice(bodyStart, startIndex), retainedMessages };
    }
    case 'latest_user': {
      const latestUserIndex = findLatestUserIndex(messages, bodyStart);
      if (latestUserIndex === null) {
        throw new Error('invalid compaction retention boundary: latest_user retention requires a user message to retain');
      }
      return { completedMessages: messages.slice(bodyStart), retainedMessages: [messages[latestUserIndex]] };
    }
    case 'none':
      return { completedMessages: messages.slice(bodyStart), retainedMessages: [] };
  }
}

function findLatestUserIndex(messages: readonly ChatMessage[], bodyStart: number): number | null {
  for (let index = messages.length - 1; index >= bodyStart; index -= 1) {
    if (String(messages[index].role || '') === 'user') {
      return index;
    }
  }
  return null;
}

import type { SiftConfig } from '../../config/index.js';
import {
  requestContextCompactionSummary,
  type ChatMessage,
  type CompactionCacheOrigin,
} from '../planner-protocol.js';
import { buildCompactionSummaryInstruction } from '../prompts.js';
import { countPlannerPromptTokens, countTokensWithFallback } from '../prompt-budget.js';
import { renderWirePrompt } from '../wire-prompt.js';
import type { JsonLogger } from '../types.js';
import { TokenUsageTracker } from './token-usage.js';
import type { MockPlannerResponseInput } from '../../planner-protocol/mock-response.js';
import {
  COMPACTION_SUMMARY_MIN_OUTPUT_TOKENS,
  splitCompactionGenerationTokens,
} from './turn-budget.js';

/** Marks the rebuilt assistant message so the model reads it as history, not as its own answer. */
export const COMPACTION_SUMMARY_MARKER = '[CONTEXT COMPACTED — SUMMARY OF PRIOR CONVERSATION]';

/** One backend hiccup is worth retrying; a second identical failure is a real failure. */
const COMPACTION_SUMMARY_ATTEMPTS = 2;

/** Which messages survive the compaction, decided by the caller, never by the compactor. */
export type CompactionRetention =
  | { kind: 'current_chat_turn'; startIndex: number }
  | { kind: 'latest_user' }
  | { kind: 'none' };

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
export class TranscriptCompactor {
  constructor(private readonly options: {
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
  }) {}

  private get tokenCountConfig(): SiftConfig | undefined {
    return this.options.useEstimatedTokensOnly ? undefined : this.options.config;
  }

  async compact(input: {
    taskId: string;
    /** The loop turn that overflowed, or null when the caller is not a loop at all. */
    turn: number | null;
    messages: readonly ChatMessage[];
    mockResponseIndex: number;
    retention: CompactionRetention;
    cacheOrigin: CompactionCacheOrigin;
  }): Promise<CompactionOutcome> {
    const messages = [...input.messages];
    const systemMessage = String(messages[0]?.role || '') === 'system' ? messages[0] : null;
    const bodyStart = systemMessage ? 1 : 0;
    const partition = partitionCompactionRetention(messages, bodyStart, input.retention);
    const instruction = buildCompactionSummaryInstruction();
    const historyMessages: ChatMessage[] = [
      ...(systemMessage ? [systemMessage] : []),
      ...partition.completedMessages,
    ];
    const summaryRequestMessages: ChatMessage[] = [...historyMessages, { role: 'user', content: instruction }];
    const generationTokens = await this.resolveSummaryGenerationTokens(input, summaryRequestMessages);

    const summary = await this.requestSummary(input, historyMessages, instruction, generationTokens);
    const rebuilt: ChatMessage[] = [
      ...(systemMessage ? [systemMessage] : []),
      buildCompactionSummaryMessage(summary.summaryText),
      ...partition.retainedMessages,
    ];
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
   * The summary generation gets whatever the window leaves after its prompt, up to the
   * run's response reserve. Two thirds cap thinking; the remaining third is the floor
   * under the summary output, not its cap — a continuation that spends less thinking
   * than the gate allows keeps the difference. The prompt side reserves nothing for
   * this request: the actual rendered prompt is measured and generation is fitted to
   * the physical remainder, failing loudly below COMPACTION_SUMMARY_MIN_OUTPUT_TOKENS.
   */
  private async resolveSummaryGenerationTokens(
    input: { taskId: string; turn: number | null; cacheOrigin: CompactionCacheOrigin },
    summaryRequestMessages: ChatMessage[],
  ): Promise<ReturnType<typeof splitCompactionGenerationTokens>> {
    const state = input.cacheOrigin.kind === 'planner'
      ? input.cacheOrigin.executing
      : input.cacheOrigin;
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
    const remainingTokens = this.options.totalContextTokens - promptTokenCount;
    const requestedTokens = splitCompactionGenerationTokens(generationTokenCeiling);
    const outputTokens = Math.min(requestedTokens.outputTokens, Math.max(remainingTokens, 0));
    const reasoningTokens = Math.min(
      requestedTokens.reasoningTokens,
      Math.max(remainingTokens - outputTokens, 0),
    );
    const generationTokens = {
      totalTokens: reasoningTokens + outputTokens,
      reasoningTokens,
      outputTokens,
    };
    if (generationTokens.outputTokens >= COMPACTION_SUMMARY_MIN_OUTPUT_TOKENS) {
      return generationTokens;
    }
    const message = `planner_compaction_prompt_overflow prompt_tokens=${promptTokenCount} `
      + `remaining_tokens=${remainingTokens} min_summary_output_tokens=${COMPACTION_SUMMARY_MIN_OUTPUT_TOKENS} `
      + `total_context_tokens=${this.options.totalContextTokens} turn=${formatTurn(input.turn)}`;
    this.options.logger?.write({
      kind: 'turn_compaction_prompt_overflow_fail',
      taskId: input.taskId,
      turn: input.turn,
      promptTokenCount,
      remainingTokens,
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
    generationTokens: ReturnType<typeof splitCompactionGenerationTokens>,
  ): Promise<{
    summaryText: string;
    nextMockResponseIndex: number;
    elapsedMs: number;
    promptCacheTokens: number | null;
    promptEvalTokens: number | null;
  }> {
    let mockResponseIndex = input.mockResponseIndex;
    let lastErrorMessage = '';
    for (let attempt = 1; attempt <= COMPACTION_SUMMARY_ATTEMPTS; attempt += 1) {
      const startedAt = Date.now();
      try {
        const response = await requestContextCompactionSummary({
          config: this.options.config,
          baseUrl: this.options.baseUrl,
          model: this.options.model,
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
        });
        if (typeof response.nextMockResponseIndex === 'number') {
          mockResponseIndex = response.nextMockResponseIndex;
        }
        const resolved = await this.options.tokenUsage.recordModelResponse(response, 0);
        this.options.tokenUsage.addOutputTokens(resolved.completionTokens, resolved.completionTokensEstimated);
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
        lastErrorMessage = error instanceof Error ? error.message : String(error);
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
      `planner_compaction_failed attempts=${COMPACTION_SUMMARY_ATTEMPTS} turn=${formatTurn(input.turn)} `
      + `last_error=${lastErrorMessage || 'unknown'}`,
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

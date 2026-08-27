import type { SiftConfig } from '../../config/index.js';
import { clampToPresetMaxTokens } from '../../lib/dynamic-output-cap.js';
import {
  buildPlannerRequestPromptReserveText,
  requestContextCompactionSummary,
  type ChatMessage,
  type PlannerThinkingFlags,
} from '../planner-protocol.js';
import { buildCompactionSummaryInstruction } from '../prompts.js';
import { countTokensWithFallback, preflightPlannerPromptBudget } from '../prompt-budget.js';
import type { JsonLogger } from '../types.js';
import { TokenUsageTracker } from './token-usage.js';
import type { MockPlannerResponseInput } from '../../planner-protocol/mock-response.js';
import {
  COMPACTION_SUMMARY_MAX_OUTPUT_TOKENS,
  COMPACTION_SUMMARY_MIN_OUTPUT_TOKENS,
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
  summarizerElapsedMs: number;
  nextMockResponseIndex: number;
  /** First message of the retained in-flight turn in the rebuilt transcript, or null when none is retained. */
  currentTurnStartIndex: number | null;
  promptCacheTokens: number | null;
  promptEvalTokens: number | null;
};

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
    thinking: PlannerThinkingFlags;
    useEstimatedTokensOnly: boolean;
    mockResponses: MockPlannerResponseInput[] | undefined;
    tokenUsage: TokenUsageTracker;
    slotId?: number;
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
    const maxOutputTokens = await this.resolveSummaryOutputTokens(input, summaryRequestMessages);

    const summary = await this.requestSummary(input, historyMessages, instruction, maxOutputTokens);
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
      summarizerElapsedMs: summary.elapsedMs,
      nextMockResponseIndex: summary.nextMockResponseIndex,
      currentTurnStartIndex: input.retention.kind === 'current_chat_turn' ? (systemMessage ? 2 : 1) : null,
      promptCacheTokens: summary.promptCacheTokens,
      promptEvalTokens: summary.promptEvalTokens,
    };
  }

  /**
   * The summary gets whatever the window leaves after the summarization prompt, up to
   * the fixed ceiling. The TurnBudget compaction reserve is what keeps that remainder
   * comfortably above the floor; dropping below it means the cap math regressed, so the
   * error names the real counts rather than silently chunking the transcript.
   */
  private async resolveSummaryOutputTokens(
    input: { taskId: string; turn: number | null },
    summaryRequestMessages: ChatMessage[],
  ): Promise<number> {
    const summaryOutputCeiling = clampToPresetMaxTokens(
      this.options.config,
      COMPACTION_SUMMARY_MAX_OUTPUT_TOKENS,
    );
    const providerPromptReserveText = buildPlannerRequestPromptReserveText({
      config: this.options.config,
      stage: 'context_compaction',
      model: this.options.model,
      messageRoles: summaryRequestMessages.map((message) => String(message.role || 'unknown')),
      tools: [],
      maxTokens: summaryOutputCeiling,
      responseSchema: null,
      ...this.options.thinking,
    });
    const preflight = await preflightPlannerPromptBudget({
      config: this.tokenCountConfig,
      messages: summaryRequestMessages,
      includeReasoningContent: this.options.thinking.reasoningContentEnabled,
      providerPromptReserveText,
      totalContextTokens: this.options.totalContextTokens,
      responseReserveTokens: 0,
    });
    const promptTokenCount = preflight.promptTokenCount;
    const remainingTokens = this.options.totalContextTokens - promptTokenCount;
    const maxOutputTokens = Math.min(
      summaryOutputCeiling,
      remainingTokens,
    );
    if (maxOutputTokens >= COMPACTION_SUMMARY_MIN_OUTPUT_TOKENS) {
      return maxOutputTokens;
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
    input: { taskId: string; turn: number | null; mockResponseIndex: number },
    historyMessages: ChatMessage[],
    instruction: string,
    maxOutputTokens: number,
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
          maxTokens: maxOutputTokens,
          slotId: this.options.slotId,
          ...this.options.thinking,
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

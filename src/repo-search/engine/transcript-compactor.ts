import type { SiftConfig } from '../../config/index.js';
import { clampToPresetMaxTokens } from '../../lib/dynamic-output-cap.js';
import {
  renderTaskTranscript,
  requestContextCompactionSummary,
  type ChatMessage,
  type PlannerThinkingFlags,
} from '../planner-protocol.js';
import { buildCompactionSummaryPrompt } from '../prompts.js';
import { countTokensWithFallback } from '../prompt-budget.js';
import type { JsonLogger } from '../types.js';
import { TokenUsageTracker } from './token-usage.js';
import {
  COMPACTION_SUMMARY_MAX_OUTPUT_TOKENS,
  COMPACTION_SUMMARY_MIN_OUTPUT_TOKENS,
} from './turn-budget.js';

/** Marks the rebuilt assistant message so the model reads it as history, not as its own answer. */
export const COMPACTION_SUMMARY_MARKER = '[CONTEXT COMPACTED — SUMMARY OF PRIOR CONVERSATION]';

/** One backend hiccup is worth retrying; a second identical failure is a real failure. */
const COMPACTION_SUMMARY_ATTEMPTS = 2;

export type CompactionOutcome = {
  messages: ChatMessage[];
  summaryText: string;
  droppedMessageCount: number;
  summaryTokenCount: number;
  summarizerElapsedMs: number;
  nextMockResponseIndex: number;
};

/** The assistant message the rebuilt transcript carries in place of the dropped history. */
export function buildCompactionSummaryMessage(summaryText: string): ChatMessage {
  return { role: 'assistant', content: `${COMPACTION_SUMMARY_MARKER}\n${summaryText}` };
}

/**
 * Replaces an over-budget transcript with one LLM-written summary of it. The rebuilt
 * transcript is `system → summary → latest user message`; everything else is dropped,
 * so the summary prompt is what decides whether the run can still resume.
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
    mockResponses: string[] | undefined;
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
  }): Promise<CompactionOutcome> {
    const messages = [...input.messages];
    const systemMessage = String(messages[0]?.role || '') === 'system' ? messages[0] : null;
    const summarizableMessages = systemMessage ? messages.slice(1) : messages;
    const prompt = buildCompactionSummaryPrompt(renderTaskTranscript(summarizableMessages));
    const maxOutputTokens = await this.resolveSummaryOutputTokens(input, prompt);

    const summary = await this.requestSummary(input, prompt, maxOutputTokens);
    const latestUserMessage = findLatestUserMessage(messages);
    const rebuilt: ChatMessage[] = [
      ...(systemMessage ? [systemMessage] : []),
      buildCompactionSummaryMessage(summary.summaryText),
      ...(latestUserMessage ? [latestUserMessage] : []),
    ];
    const keptMessageCount = (systemMessage ? 1 : 0) + (latestUserMessage ? 1 : 0);

    return {
      messages: rebuilt,
      summaryText: summary.summaryText,
      droppedMessageCount: messages.length - keptMessageCount,
      summaryTokenCount: await countTokensWithFallback(this.tokenCountConfig, summary.summaryText),
      summarizerElapsedMs: summary.elapsedMs,
      nextMockResponseIndex: summary.nextMockResponseIndex,
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
    prompt: string,
  ): Promise<number> {
    const promptTokenCount = await countTokensWithFallback(this.tokenCountConfig, prompt);
    const remainingTokens = this.options.totalContextTokens - promptTokenCount;
    const maxOutputTokens = Math.min(
      clampToPresetMaxTokens(this.options.config, COMPACTION_SUMMARY_MAX_OUTPUT_TOKENS),
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
    prompt: string,
    maxOutputTokens: number,
  ): Promise<{ summaryText: string; nextMockResponseIndex: number; elapsedMs: number }> {
    let mockResponseIndex = input.mockResponseIndex;
    let lastErrorMessage = '';
    for (let attempt = 1; attempt <= COMPACTION_SUMMARY_ATTEMPTS; attempt += 1) {
      const startedAt = Date.now();
      try {
        const response = await requestContextCompactionSummary({
          config: this.options.config,
          baseUrl: this.options.baseUrl,
          model: this.options.model,
          prompt,
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
          return { summaryText, nextMockResponseIndex: mockResponseIndex, elapsedMs: Date.now() - startedAt };
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

function findLatestUserMessage(messages: readonly ChatMessage[]): ChatMessage | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (String(message.role || '') === 'user') {
      return message;
    }
  }
  return null;
}

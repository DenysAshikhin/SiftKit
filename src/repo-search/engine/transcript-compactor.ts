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
import { COMPACTION_SUMMARY_MAX_OUTPUT_TOKENS } from './turn-budget.js';

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
    turn: number;
    messages: readonly ChatMessage[];
    mockResponseIndex: number;
  }): Promise<CompactionOutcome> {
    const messages = [...input.messages];
    const systemMessage = String(messages[0]?.role || '') === 'system' ? messages[0] : null;
    const summarizableMessages = systemMessage ? messages.slice(1) : messages;
    const prompt = buildCompactionSummaryPrompt(renderTaskTranscript(summarizableMessages));
    const maxOutputTokens = clampToPresetMaxTokens(this.options.config, COMPACTION_SUMMARY_MAX_OUTPUT_TOKENS);
    await this.assertPromptFitsSingleShot(input, prompt, maxOutputTokens);

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
   * Unreachable unless the TurnBudget compaction reserve regressed: a transcript is
   * capped so this request always fits. Name the real counts rather than silently
   * chunking, so the cap math is what gets fixed.
   */
  private async assertPromptFitsSingleShot(
    input: { taskId: string; turn: number },
    prompt: string,
    maxOutputTokens: number,
  ): Promise<void> {
    const promptTokenCount = await countTokensWithFallback(this.tokenCountConfig, prompt);
    const availableTokens = this.options.totalContextTokens - maxOutputTokens;
    if (promptTokenCount <= availableTokens) {
      return;
    }
    const message = `planner_compaction_prompt_overflow prompt_tokens=${promptTokenCount} `
      + `available_tokens=${availableTokens} total_context_tokens=${this.options.totalContextTokens} `
      + `summary_output_tokens=${maxOutputTokens} turn=${input.turn}`;
    this.options.logger?.write({
      kind: 'turn_compaction_prompt_overflow_fail',
      taskId: input.taskId,
      turn: input.turn,
      promptTokenCount,
      availableTokens,
      totalContextTokens: this.options.totalContextTokens,
      summaryOutputTokens: maxOutputTokens,
      error: message,
    });
    throw new Error(message);
  }

  private async requestSummary(
    input: { taskId: string; turn: number; mockResponseIndex: number },
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
      `planner_compaction_failed attempts=${COMPACTION_SUMMARY_ATTEMPTS} turn=${input.turn} `
      + `last_error=${lastErrorMessage || 'unknown'}`,
    );
  }
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

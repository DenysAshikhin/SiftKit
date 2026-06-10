import type { SiftConfig } from '../../config/index.js';
import { getDynamicMaxOutputTokens } from '../../lib/dynamic-output-cap.js';
import { requestTerminalSynthesis } from '../planner-protocol.js';
import { countTokensWithFallback } from '../prompt-budget.js';
import { buildTerminalSynthesisPrompt } from '../prompts.js';
import type { JsonLogger } from '../types.js';
import { ProgressReporter } from './progress-reporter.js';
import { TokenUsageTracker } from './token-usage.js';

const MAX_SYNTHESIS_ATTEMPTS = 3;

export class TerminalSynthesizer {
  constructor(private readonly options: {
    baseUrl: string;
    model: string;
    timeoutMs: number;
    config: SiftConfig | undefined;
    useEstimatedTokensOnly: boolean;
    totalContextTokens: number;
    thinkingEnabled: boolean;
    reasoningContentEnabled: boolean;
    preserveThinking: boolean;
    streamFinishAsAnswer: boolean;
    logger: JsonLogger | null;
    progress: ProgressReporter;
    tokenUsage: TokenUsageTracker;
  }) {}

  async synthesize(input: {
    taskId: string;
    question: string;
    reason: string;
    transcript: string;
    turnsUsed: number;
    mockResponses?: string[];
    mockResponseIndex: number;
  }): Promise<{ finalOutput: string; nextMockResponseIndex: number }> {
    const synthesisPrompt = buildTerminalSynthesisPrompt({
      question: input.question,
      reason: input.reason,
      transcript: input.transcript,
    });
    const synthesisPromptTokenCount = await countTokensWithFallback(
      this.options.useEstimatedTokensOnly ? undefined : this.options.config,
      synthesisPrompt,
    );
    const synthesisMaxTokens = getDynamicMaxOutputTokens({
      totalContextTokens: this.options.totalContextTokens,
      promptTokenCount: synthesisPromptTokenCount,
    });
    this.options.logger?.write({
      kind: 'task_terminal_synthesis_requested',
      taskId: input.taskId,
      reason: input.reason,
      promptTokenCount: synthesisPromptTokenCount,
      maxOutputTokens: synthesisMaxTokens,
    });
    let mockResponseIndex = input.mockResponseIndex;
    let finalOutput = '';
    let lastErrorMessage = '';
    let successAttempt = 0;
    for (let attempt = 1; attempt <= MAX_SYNTHESIS_ATTEMPTS; attempt += 1) {
      try {
        const synthesisResponse = await requestTerminalSynthesis({
          baseUrl: this.options.baseUrl,
          model: this.options.model,
          prompt: synthesisPrompt,
          timeoutMs: this.options.timeoutMs,
          mockResponses: input.mockResponses,
          mockResponseIndex,
          maxTokens: synthesisMaxTokens,
          thinkingEnabled: this.options.thinkingEnabled,
          reasoningContentEnabled: this.options.reasoningContentEnabled,
          preserveThinking: this.options.preserveThinking,
          logger: this.options.logger,
          stream: this.options.streamFinishAsAnswer && this.options.progress.enabled,
          onContentDelta: this.options.streamFinishAsAnswer && this.options.progress.enabled
            ? (answerText: string) => { this.options.progress.answer(input.turnsUsed, answerText); }
            : undefined,
        });
        if (typeof synthesisResponse.nextMockResponseIndex === 'number') {
          mockResponseIndex = synthesisResponse.nextMockResponseIndex;
        }
        const resolved = await this.options.tokenUsage.recordModelResponse(synthesisResponse);
        this.options.tokenUsage.addOutputTokens(resolved.completionTokens, resolved.completionTokensEstimated);

        const text = String(synthesisResponse.text || '').trim();
        if (!synthesisResponse.mockExhausted && text) {
          finalOutput = text;
          if (this.options.streamFinishAsAnswer && this.options.progress.enabled) {
            this.options.progress.answer(input.turnsUsed, finalOutput);
          }
          successAttempt = attempt;
          break;
        }
        lastErrorMessage = synthesisResponse.mockExhausted ? 'mock_exhausted' : 'empty_output';
        this.options.logger?.write({ kind: 'task_terminal_synthesis_retry', taskId: input.taskId, attempt, error: lastErrorMessage });
      } catch (error) {
        lastErrorMessage = error instanceof Error ? error.message : String(error);
        this.options.logger?.write({ kind: 'task_terminal_synthesis_retry', taskId: input.taskId, attempt, error: lastErrorMessage });
      }
    }
    if (!String(finalOutput || '').trim()) {
      this.options.logger?.write({ kind: 'task_terminal_synthesis_failed', taskId: input.taskId, reason: input.reason, lastError: lastErrorMessage });
      throw new Error(`Terminal synthesis produced no usable output after ${MAX_SYNTHESIS_ATTEMPTS} attempts (reason=${input.reason}, last=${lastErrorMessage || 'unknown'}).`);
    }
    this.options.logger?.write({ kind: 'task_terminal_synthesis_result', taskId: input.taskId, attempt: successAttempt, finalOutput });
    return { finalOutput, nextMockResponseIndex: mockResponseIndex };
  }
}

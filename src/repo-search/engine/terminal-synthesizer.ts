import type { SiftConfig } from '../../config/index.js';
import { getDynamicMaxOutputTokens } from '../../lib/dynamic-output-cap.js';
import { computeResponseReserveTokens } from '../../lib/response-reserve.js';
import {
  appendPlannerInstruction,
  buildPlannerRequestPromptReserveText,
  requestTerminalSynthesis,
  type ChatMessage,
  type ExecutingPlannerRequest,
} from '../planner-protocol.js';
import { preflightPlannerPromptBudget } from '../prompt-budget.js';
import { buildTerminalSynthesisInstruction } from '../prompts.js';
import type { JsonLogger } from '../types.js';
import { ProgressReporter } from './progress-reporter.js';
import { TokenUsageTracker } from './token-usage.js';
import type { MockPlannerResponseInput } from '../../planner-protocol/mock-response.js';

const MAX_SYNTHESIS_ATTEMPTS = 3;

export class TerminalSynthesizer {
  constructor(private readonly options: {
    baseUrl: string;
    model: string;
    timeoutMs: number;
    config: SiftConfig;
    useEstimatedTokensOnly: boolean;
    totalContextTokens: number;
    streamFinishAsAnswer: boolean;
    logger: JsonLogger | null;
    progress: ProgressReporter;
    tokenUsage: TokenUsageTracker;
  }) {}

  async synthesize(input: {
    taskId: string;
    reason: string;
    messages: readonly ChatMessage[];
    executing: ExecutingPlannerRequest;
    turnsUsed: number;
    mockResponses?: MockPlannerResponseInput[];
    mockResponseIndex: number;
  }): Promise<{ finalOutput: string; nextMockResponseIndex: number }> {
    const terminalMessages = appendPlannerInstruction(
      input.messages,
      buildTerminalSynthesisInstruction(input.reason),
    );
    const providerPromptReserveText = buildPlannerRequestPromptReserveText({
      config: this.options.config,
      model: this.options.model,
      messageRoles: terminalMessages.map((message) => message.role),
      tools: input.executing.tools,
      maxTokens: computeResponseReserveTokens({
        config: this.options.config,
        totalContextTokens: this.options.totalContextTokens,
      }),
      responseSchema: null,
      ...input.executing.flags,
    });
    const preflight = await preflightPlannerPromptBudget({
      config: this.options.useEstimatedTokensOnly ? undefined : this.options.config,
      messages: terminalMessages,
      includeReasoningContent: input.executing.flags.reasoningContentEnabled,
      providerPromptReserveText,
      totalContextTokens: this.options.totalContextTokens,
      responseReserveTokens: 0,
    });
    const synthesisPromptTokenCount = preflight.promptTokenCount;
    const synthesisMaxTokens = getDynamicMaxOutputTokens({
      config: this.options.config,
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
          config: this.options.config,
          baseUrl: this.options.baseUrl,
          model: this.options.model,
          messages: terminalMessages,
          executing: input.executing,
          timeoutMs: this.options.timeoutMs,
          mockResponses: input.mockResponses,
          mockResponseIndex,
          maxTokens: synthesisMaxTokens,
          logger: this.options.logger,
          onContentDelta: this.options.streamFinishAsAnswer && this.options.progress.liveTextEnabled
            ? (snapshot) => { this.options.progress.answer(input.turnsUsed, snapshot.narrationText); }
            : undefined,
        });
        if (typeof synthesisResponse.nextMockResponseIndex === 'number') {
          mockResponseIndex = synthesisResponse.nextMockResponseIndex;
        }
        const resolved = await this.options.tokenUsage.recordModelResponse(synthesisResponse, synthesisPromptTokenCount);
        this.options.tokenUsage.addOutputTokens(resolved.completionTokens, resolved.completionTokensEstimated);

        const text = String(synthesisResponse.text || '').trim();
        if (!synthesisResponse.mockExhausted && text) {
          finalOutput = text;
          if (this.options.streamFinishAsAnswer && this.options.progress.liveTextEnabled) {
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

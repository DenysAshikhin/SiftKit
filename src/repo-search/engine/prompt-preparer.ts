import type { SiftConfig } from '../../config/index.js';
import { getDynamicMaxOutputTokens } from '../../lib/dynamic-output-cap.js';
import type { TemporaryTimingRecorder } from '../../lib/temporary-timing-recorder.js';
import { estimateTokenCount } from '../../lib/token-estimate.js';
import {
  buildPlannerRequestPromptReserveText,
  plannerMessageKeepsReasoningContent,
  resolveRepoSearchPlannerToolDefinitions,
  type ChatMessage,
  type PlannerThinkingFlags,
} from '../planner-protocol.js';
import { IncrementalTokenCounter } from '../incremental-token-counter.js';
import { preflightPlannerPromptBudget } from '../prompt-budget.js';
import type { JsonLogger } from '../types.js';
import { ProgressReporter } from './progress-reporter.js';
import { TranscriptManager } from './transcript-manager.js';
import { TranscriptCompactor } from './transcript-compactor.js';
import { TurnBudget } from './turn-budget.js';

/** Log visibility only: a character estimate of the preserved reasoning mass, no extra tokenize round-trip. */
function estimateReasoningTokens(config: SiftConfig, messages: readonly ChatMessage[], reasoningContentEnabled: boolean): number {
  let tokens = 0;
  for (const message of messages) {
    if (plannerMessageKeepsReasoningContent(message, reasoningContentEnabled)) {
      tokens += estimateTokenCount(config, String(message.reasoning_content));
    }
  }
  return tokens;
}

export type PreparedTurnBudget = {
  promptTokenCount: number;
  maxOutputTokens: number;
  /** The raw summary text when this turn compacted, else null. */
  compactionSummary: string | null;
  nextMockResponseIndex: number;
};

export class PromptPreparer {
  constructor(
    private readonly options: {
      taskId: string;
      model: string;
      config: SiftConfig;
      useEstimatedTokensOnly: boolean;
      budget: TurnBudget;
      plannerToolDefinitions: ReturnType<typeof resolveRepoSearchPlannerToolDefinitions>;
      thinking: PlannerThinkingFlags;
      transcript: TranscriptManager;
      compactor: TranscriptCompactor;
      progress: ProgressReporter;
      logger: JsonLogger | null;
      timingRecorder: TemporaryTimingRecorder | null;
    },
  ) {}

  private readonly transcriptTokenCounter = new IncrementalTokenCounter();
  private readonly reserveTokenCounter = new IncrementalTokenCounter();

  private buildProviderPromptReserveText(messageRoles: readonly string[], maxTokens: number): string {
    return buildPlannerRequestPromptReserveText({
      config: this.options.config,
      stage: 'planner_action',
      model: String(this.options.model || ''),
      messageRoles,
      toolDefinitions: this.options.plannerToolDefinitions,
      maxTokens,
      ...this.options.thinking,
    });
  }

  async prepareTurn(turn: number, mockResponseIndex: number): Promise<PreparedTurnBudget> {
    const { taskId, budget, transcript, progress } = this.options;
    const promptRenderSpan = this.options.timingRecorder?.start('repo.prompt.render', {
      taskId,
      turn,
      messageCount: transcript.length,
    });
    let providerPromptReserveText = this.buildProviderPromptReserveText(
      transcript.messageRoles(),
      budget.totalContextTokens,
    );
    let prompt = transcript.render(this.options.thinking.reasoningContentEnabled);
    promptRenderSpan?.end({
      promptChars: prompt.length,
      providerPromptReserveChars: providerPromptReserveText.length,
    });
    const preflightSpan = this.options.timingRecorder?.start('repo.prompt.preflight', {
      taskId,
      turn,
    });
    progress.preflightStart(turn, prompt.length);
    this.options.logger?.write({ kind: 'turn_preflight_start', taskId, turn, promptChars: prompt.length });
    const preflightConfig = this.options.useEstimatedTokensOnly ? undefined : this.options.config;
    if (preflightConfig) {
      progress.tokenizeStart(turn, prompt.length);
    }
    let preflight = await preflightPlannerPromptBudget({
      config: preflightConfig,
      prompt,
      providerPromptReserveText,
      totalContextTokens: budget.totalContextTokens,
      responseReserveTokens: budget.responseReserveTokens,
      transcriptTokenCounter: this.transcriptTokenCounter,
      reserveTokenCounter: this.reserveTokenCounter,
    });
    preflightSpan?.end({
      promptTokenCount: preflight.promptTokenCount,
      overflowTokens: preflight.overflowTokens,
      ok: preflight.ok,
    });
    progress.preflightDone(turn, prompt.length, preflight.promptTokenCount);
    if (preflight.tokenizationAttempted) {
      progress.tokenizeDone(turn, prompt.length, preflight);
    }
    let maxOutputTokens = getDynamicMaxOutputTokens({
      config: this.options.config,
      totalContextTokens: budget.totalContextTokens,
      promptTokenCount: preflight.promptTokenCount,
    });

    this.options.logger?.write({
      kind: 'turn_preflight_budget',
      taskId,
      turn,
      promptTokenCount: preflight.promptTokenCount,
      reasoningTokenEstimate: estimateReasoningTokens(this.options.config, transcript.getMessages(), this.options.thinking.reasoningContentEnabled),
      tokenizeElapsedMs: preflight.tokenizeElapsedMs ?? null,
      tokenCountSource: preflight.tokenCountSource,
      transcriptPromptTokenCount: preflight.transcriptPromptTokenCount,
      providerPromptReserveTokenCount: preflight.providerPromptReserveTokenCount,
      maxPromptBudget: preflight.maxPromptBudget,
      overflowTokens: preflight.overflowTokens,
      ok: preflight.ok,
      compacted: false,
      maxOutputTokens,
    });

    let compactionSummary: string | null = null;
    let nextMockResponseIndex = mockResponseIndex;

    if (!preflight.ok) {
      const compactionSpan = this.options.timingRecorder?.start('repo.prompt.compact', {
        taskId,
        turn,
        beforePromptTokenCount: preflight.promptTokenCount,
      });
      const compacted = await this.options.compactor.compact({
        taskId,
        turn,
        messages: transcript.getMessages(),
        mockResponseIndex,
      });
      compactionSummary = compacted.summaryText;
      nextMockResponseIndex = compacted.nextMockResponseIndex;
      transcript.replaceWith(compacted.messages);
      const beforeProviderPromptReserveTokenCount = preflight.providerPromptReserveTokenCount;
      providerPromptReserveText = this.buildProviderPromptReserveText(
        transcript.messageRoles(),
        budget.totalContextTokens,
      );
      prompt = transcript.render(this.options.thinking.reasoningContentEnabled);
      if (preflightConfig) {
        progress.tokenizeStart(turn, prompt.length);
      }
      const afterCompaction = await preflightPlannerPromptBudget({
        config: preflightConfig,
        prompt,
        providerPromptReserveText,
        totalContextTokens: budget.totalContextTokens,
        responseReserveTokens: budget.responseReserveTokens,
        transcriptTokenCounter: this.transcriptTokenCounter,
        reserveTokenCounter: this.reserveTokenCounter,
      });
      if (afterCompaction.tokenizationAttempted) {
        progress.tokenizeDone(turn, prompt.length, afterCompaction);
      }
      compactionSpan?.end({
        afterPromptTokenCount: afterCompaction.promptTokenCount,
        droppedMessageCount: compacted.droppedMessageCount,
      });
      maxOutputTokens = getDynamicMaxOutputTokens({
        config: this.options.config,
        totalContextTokens: budget.totalContextTokens,
        promptTokenCount: afterCompaction.promptTokenCount,
      });
      this.options.logger?.write({
        kind: 'turn_preflight_compaction_applied',
        taskId,
        turn,
        beforePromptTokenCount: preflight.promptTokenCount,
        afterPromptTokenCount: afterCompaction.promptTokenCount,
        reasoningTokenEstimate: estimateReasoningTokens(this.options.config, transcript.getMessages(), this.options.thinking.reasoningContentEnabled),
        transcriptPromptTokenCount: afterCompaction.transcriptPromptTokenCount,
        beforeProviderPromptReserveTokenCount,
        providerPromptReserveTokenCount: afterCompaction.providerPromptReserveTokenCount,
        maxPromptBudget: afterCompaction.maxPromptBudget,
        droppedMessageCount: compacted.droppedMessageCount,
        summaryTokenCount: compacted.summaryTokenCount,
        summarizerElapsedMs: compacted.summarizerElapsedMs,
        maxOutputTokens,
      });
      preflight = afterCompaction;
    }

    if (!preflight.ok) {
      const overflowError = new Error(
        `planner_preflight_overflow prompt_tokens=${preflight.promptTokenCount} ` +
          `max_prompt_tokens=${preflight.maxPromptBudget} overflow_tokens=${preflight.overflowTokens} ` +
          `max_output_tokens=${maxOutputTokens} total_context_tokens=${budget.totalContextTokens} ` +
          `response_reserve_tokens=${budget.responseReserveTokens} compacted=true`,
      );
      this.options.logger?.write({
        kind: 'turn_preflight_overflow_fail',
        taskId,
        turn,
        promptTokenCount: preflight.promptTokenCount,
        transcriptPromptTokenCount: preflight.transcriptPromptTokenCount,
        providerPromptReserveTokenCount: preflight.providerPromptReserveTokenCount,
        maxPromptBudget: preflight.maxPromptBudget,
        overflowTokens: preflight.overflowTokens,
        maxOutputTokens,
        totalContextTokens: budget.totalContextTokens,
        responseReserveTokens: budget.responseReserveTokens,
        error: overflowError.message,
      });
      throw overflowError;
    }

    return {
      promptTokenCount: preflight.promptTokenCount,
      maxOutputTokens,
      compactionSummary,
      nextMockResponseIndex,
    };
  }
}

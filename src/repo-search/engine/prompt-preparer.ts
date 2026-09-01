import type { SiftConfig } from '../../config/index.js';
import { getDynamicMaxOutputTokens } from '../../lib/dynamic-output-cap.js';
import type { TemporaryTimingRecorder } from '../../lib/temporary-timing-recorder.js';
import { estimateTokenCount } from '../../lib/token-estimate.js';
import {
  plannerMessageKeepsReasoningContent,
  type ChatMessage,
  type CompactionCacheOrigin,
  type PlannerThinkingFlags,
} from '../planner-protocol.js';
import type { LlamaCppToolDefinition } from '../../llm-protocol/types.js';
import { IncrementalTokenCounter } from '../incremental-token-counter.js';
import { preflightPlannerPromptBudget, type PreflightResult } from '../prompt-budget.js';
import { renderWirePrompt } from '../wire-prompt.js';
import type { JsonLogger } from '../types.js';
import { ProgressReporter } from './progress-reporter.js';
import { TranscriptManager } from './transcript-manager.js';
import {
  TranscriptCompactor,
  writePromptCacheEpochReset,
  type CompactionRetention,
} from './transcript-compactor.js';
import { TurnBudget } from './turn-budget.js';
import type { RepoSearchRuntimeProfile } from './runtime-profile.js';

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

export type PreparedTurnBudget =
  | {
      kind: 'ready';
      promptTokenCount: number;
      maxOutputTokens: number;
      /** The raw summary text when this turn compacted, else null. */
      compactionSummary: string | null;
      nextMockResponseIndex: number;
    }
  | {
      kind: 'context_overflow';
      promptTokenCount: number;
      maxPromptBudget: number;
      overflowTokens: number;
      maxOutputTokens: number;
    };

export class PromptPreparer {
  constructor(
    private readonly options: {
      taskId: string;
      model: string;
      config: SiftConfig;
      useEstimatedTokensOnly: boolean;
      budget: TurnBudget;
      plannerTools: readonly LlamaCppToolDefinition[];
      thinking: PlannerThinkingFlags;
      transcript: TranscriptManager;
      runtimeProfile: RepoSearchRuntimeProfile;
      compactor: TranscriptCompactor;
      progress: ProgressReporter;
      logger: JsonLogger | null;
      timingRecorder: TemporaryTimingRecorder | null;
    },
  ) {}

  private readonly promptTokenCounter = new IncrementalTokenCounter();

  /** Chars of the rendered wire prompt, for the progress events that fire before preflight counts it. */
  private wirePromptChars(): number {
    return renderWirePrompt({
      messages: this.options.transcript.getMessages(),
      tools: this.options.plannerTools,
      responseFormat: null,
      includeReasoningContent: this.options.thinking.reasoningContentEnabled,
    }).length;
  }

  private failOverflow(
    preflight: PreflightResult,
    maxOutputTokens: number,
    turn: number,
    compacted: boolean,
  ): never {
    const { taskId, budget } = this.options;
    const overflowError = new Error(
      `planner_preflight_overflow prompt_tokens=${preflight.promptTokenCount} `
        + `max_prompt_tokens=${preflight.maxPromptBudget} overflow_tokens=${preflight.overflowTokens} `
        + `max_output_tokens=${maxOutputTokens} total_context_tokens=${budget.totalContextTokens} `
        + `response_reserve_tokens=${budget.responseReserveTokens} compacted=${compacted}`,
    );
    this.options.logger?.write({
      kind: 'turn_preflight_overflow_fail',
      taskId,
      turn,
      promptTokenCount: preflight.promptTokenCount,
      maxPromptBudget: preflight.maxPromptBudget,
      overflowTokens: preflight.overflowTokens,
      maxOutputTokens,
      totalContextTokens: budget.totalContextTokens,
      responseReserveTokens: budget.responseReserveTokens,
      error: overflowError.message,
    });
    throw overflowError;
  }

  async prepareTurn(
    turn: number,
    mockResponseIndex: number,
    cacheOrigin: CompactionCacheOrigin,
  ): Promise<PreparedTurnBudget> {
    const { taskId, budget, transcript, progress } = this.options;
    const promptRenderSpan = this.options.timingRecorder?.start('repo.prompt.render', {
      taskId,
      turn,
      messageCount: transcript.length,
    });
    let promptChars = this.wirePromptChars();
    promptRenderSpan?.end({ promptChars });
    const preflightSpan = this.options.timingRecorder?.start('repo.prompt.preflight', {
      taskId,
      turn,
    });
    progress.preflightStart(turn, promptChars);
    this.options.logger?.write({ kind: 'turn_preflight_start', taskId, turn, promptChars });
    const preflightConfig = this.options.useEstimatedTokensOnly ? undefined : this.options.config;
    if (preflightConfig) {
      progress.tokenizeStart(turn, promptChars);
    }
    let preflight = await preflightPlannerPromptBudget({
      config: preflightConfig,
      messages: transcript.getMessages(),
      includeReasoningContent: this.options.thinking.reasoningContentEnabled,
      tools: this.options.plannerTools,
      responseFormat: null,
      totalContextTokens: budget.totalContextTokens,
      responseReserveTokens: budget.responseReserveTokens,
      promptTokenCounter: this.promptTokenCounter,
    });
    preflightSpan?.end({
      promptTokenCount: preflight.promptTokenCount,
      overflowTokens: preflight.overflowTokens,
      ok: preflight.ok,
    });
    progress.preflightDone(turn, preflight.promptChars, preflight.promptTokenCount);
    if (preflight.tokenizationAttempted) {
      progress.tokenizeDone(turn, preflight.promptChars, preflight);
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
      maxPromptBudget: preflight.maxPromptBudget,
      overflowTokens: preflight.overflowTokens,
      ok: preflight.ok,
      compacted: false,
      maxOutputTokens,
    });

    let compactionSummary: string | null = null;
    let nextMockResponseIndex = mockResponseIndex;

    if (!preflight.ok) {
      if (this.options.runtimeProfile.contextOverflowPolicy === 'force_answer') {
        // repo-search answers from the evidence it already has: no compaction, no transcript
        // mutation, no mock-response advance — the loop stops and terminal synthesis takes over.
        this.options.logger?.write({
          kind: 'turn_preflight_forced_answer',
          taskId,
          turn,
          promptTokenCount: preflight.promptTokenCount,
          maxPromptBudget: preflight.maxPromptBudget,
          overflowTokens: preflight.overflowTokens,
          maxOutputTokens,
          totalContextTokens: budget.totalContextTokens,
          responseReserveTokens: budget.responseReserveTokens,
        });
        return {
          kind: 'context_overflow',
          promptTokenCount: preflight.promptTokenCount,
          maxPromptBudget: preflight.maxPromptBudget,
          overflowTokens: preflight.overflowTokens,
          maxOutputTokens,
        };
      }
      const compactionSpan = this.options.timingRecorder?.start('repo.prompt.compact', {
        taskId,
        turn,
        beforePromptTokenCount: preflight.promptTokenCount,
      });
      const retention: CompactionRetention = this.options.runtimeProfile.loopKind === 'chat'
        ? { kind: 'current_chat_turn', startIndex: transcript.currentTurnStartIndex }
        : { kind: 'latest_user' };
      const compacted = await this.options.compactor.compact({
        taskId,
        turn,
        messages: transcript.getMessages(),
        mockResponseIndex,
        retention,
        cacheOrigin,
      });
      compactionSummary = compacted.summaryText;
      nextMockResponseIndex = compacted.nextMockResponseIndex;
      transcript.replaceWith(compacted.messages, compacted.currentTurnStartIndex);
      writePromptCacheEpochReset(this.options.logger, {
        taskId,
        turn,
        droppedMessageCount: compacted.droppedMessageCount,
      });
      promptChars = this.wirePromptChars();
      if (preflightConfig) {
        progress.tokenizeStart(turn, promptChars);
      }
      const afterCompaction = await preflightPlannerPromptBudget({
        config: preflightConfig,
        messages: transcript.getMessages(),
        includeReasoningContent: this.options.thinking.reasoningContentEnabled,
        tools: this.options.plannerTools,
        responseFormat: null,
        totalContextTokens: budget.totalContextTokens,
        responseReserveTokens: budget.responseReserveTokens,
        promptTokenCounter: this.promptTokenCounter,
      });
      if (afterCompaction.tokenizationAttempted) {
        progress.tokenizeDone(turn, afterCompaction.promptChars, afterCompaction);
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
        maxPromptBudget: afterCompaction.maxPromptBudget,
        droppedMessageCount: compacted.droppedMessageCount,
        summaryTokenCount: compacted.summaryTokenCount,
        summaryGenerationTokenBudget: compacted.summaryGenerationTokenBudget,
        summaryReasoningTokenBudget: compacted.summaryReasoningTokenBudget,
        summaryOutputTokenBudget: compacted.summaryOutputTokenBudget,
        summarizerElapsedMs: compacted.summarizerElapsedMs,
        promptCacheTokens: compacted.promptCacheTokens,
        promptEvalTokens: compacted.promptEvalTokens,
        maxOutputTokens,
      });
      preflight = afterCompaction;
    }

    if (!preflight.ok) {
      this.failOverflow(preflight, maxOutputTokens, turn, true);
    }

    return {
      kind: 'ready',
      promptTokenCount: preflight.promptTokenCount,
      maxOutputTokens,
      compactionSummary,
      nextMockResponseIndex,
    };
  }
}

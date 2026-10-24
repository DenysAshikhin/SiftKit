import type { SiftConfig } from '../../config/index.ts';
import type { ChatMessage } from '../planner-chat-message.ts';
import { countTokensWithFallback } from '../prompt-budget.ts';
import type { OrchestratorToolHost } from './orchestrator-tool-host.ts';
import {
  buildCompactionSummaryMessage,
  type CompactionInput,
  type CompactionOutcome,
  type TranscriptCompaction,
} from './transcript-compactor.ts';

/**
 * Rebuilds an orchestrator transcript as `system → run digest → task` with no model call: the run's
 * stored plan, ledger and reports are its memory, so nothing a summary could lose is dropped.
 */
export class RunStateCompactor implements TranscriptCompaction {
  private readonly host: OrchestratorToolHost;
  private readonly tokenCountConfig: SiftConfig | undefined;

  constructor(host: OrchestratorToolHost, tokenCountConfig: SiftConfig | undefined) {
    this.host = host;
    this.tokenCountConfig = tokenCountConfig;
  }

  async compact(input: CompactionInput): Promise<CompactionOutcome> {
    const systemMessage = input.messages[0]?.role === 'system' ? input.messages[0] : null;
    const task = input.messages.find((message) => message.role === 'user');
    if (task === undefined) {
      throw new Error('RunStateCompactor: the transcript has no task message to keep');
    }
    const digest = this.host.contextDigest();
    const messages: ChatMessage[] = [...(systemMessage ? [systemMessage] : []), buildCompactionSummaryMessage(digest), task];
    return {
      messages,
      summaryText: digest,
      droppedMessageCount: input.messages.length - (messages.length - 1),
      summaryTokenCount: await countTokensWithFallback(this.tokenCountConfig, digest),
      summaryGenerationTokenBudget: 0,
      summaryReasoningTokenBudget: 0,
      summaryOutputTokenBudget: 0,
      summarizerElapsedMs: 0,
      nextMockResponseIndex: input.mockResponseIndex,
      currentTurnStartIndex: null,
      promptCacheTokens: null,
      promptEvalTokens: null,
    };
  }
}

import {
  getActiveModelPreset,
  getConfiguredEngineBaseUrl,
  SIFT_DEFAULT_ENGINE_BASE_URL,
  type SiftConfig,
} from '../config/index.js';
import type { MockPlannerResponse } from '../planner-protocol/mock-response.js';
import { countTokensWithFallbackDetailed } from '../repo-search/prompt-budget.js';
import type { ChatSession } from '../state/chat-sessions.js';
import type { PersistTurn } from './chat.js';

const CHAT_TOKEN_COUNT_TIMEOUT_MS = 1_000;

/** Which config the telemetry counts tokens against: a mocked turn never reaches a tokenizer. */
export function getMockTokenConfig(config: SiftConfig, mockResponses: MockPlannerResponse[] | undefined): SiftConfig | undefined {
  return Array.isArray(mockResponses) ? undefined : config;
}

/** The default engine base URL means no local tokenizer to reach, so counting falls back. */
export function getLocalTokenConfig(config: SiftConfig): SiftConfig | undefined {
  const baseUrl = getConfiguredEngineBaseUrl(config);
  return baseUrl === SIFT_DEFAULT_ENGINE_BASE_URL ? undefined : config;
}

export type ChatInputTokenCount = {
  tokenCount: number;
  estimated: boolean;
};

export class ChatTurnTelemetry {
  constructor(
    private readonly config: SiftConfig,
    private readonly tokenConfig: SiftConfig | undefined,
  ) {}

  async countInputTokens(content: string): Promise<ChatInputTokenCount> {
    if (!content.trim()) {
      return { tokenCount: 0, estimated: false };
    }
    const count = await this.countTokens(content);
    return {
      tokenCount: count.tokenCount,
      estimated: count.source === 'estimate',
    };
  }

  async countThinkingTokens(turns: PersistTurn[]): Promise<PersistTurn[]> {
    const countedTurns: PersistTurn[] = [];
    for (const turn of turns) {
      const thinkingText = turn.thinkingText.trim();
      if (!thinkingText) {
        countedTurns.push(turn);
        continue;
      }
      const count = await this.countTokens(thinkingText);
      countedTurns.push({
        ...turn,
        thinkingTokens: count.tokenCount,
        thinkingTokensEstimated: count.source === 'estimate',
      });
    }
    return countedTurns;
  }

  shouldMaintainPerStepThinking(session: ChatSession): boolean {
    const activePreset = getActiveModelPreset(this.config);
    return session.thinkingEnabled !== false
      && activePreset.Reasoning === 'on'
      && activePreset.MaintainPerStepThinking !== false;
  }

  private countTokens(content: string): ReturnType<typeof countTokensWithFallbackDetailed> {
    return countTokensWithFallbackDetailed(this.tokenConfig, content, {
      timeoutMs: CHAT_TOKEN_COUNT_TIMEOUT_MS,
      retryMaxWaitMs: CHAT_TOKEN_COUNT_TIMEOUT_MS,
    });
  }
}

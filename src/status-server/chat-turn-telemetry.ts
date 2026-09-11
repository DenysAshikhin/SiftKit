import {
  getConfiguredEngineBaseUrl,
  SIFT_DEFAULT_ENGINE_BASE_URL,
  type SiftConfig,
} from '../config/index.js';
import type { MockPlannerResponse } from '../planner-protocol/mock-response.js';
import { countTokensWithFallbackDetailed } from '../repo-search/prompt-budget.js';

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

/** Measures a submission against the tokenizer `tokenConfig` names, or estimates when there is none. */
export async function countChatInputTokens(tokenConfig: SiftConfig | undefined, content: string): Promise<ChatInputTokenCount> {
  if (!content.trim()) return { tokenCount: 0, estimated: false };
  const count = await countTokensWithFallbackDetailed(tokenConfig, content, {
    timeoutMs: CHAT_TOKEN_COUNT_TIMEOUT_MS,
    retryMaxWaitMs: CHAT_TOKEN_COUNT_TIMEOUT_MS,
  });
  return { tokenCount: count.tokenCount, estimated: count.source === 'estimate' };
}

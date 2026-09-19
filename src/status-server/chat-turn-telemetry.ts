import {
  getConfiguredEngineBaseUrl,
  SIFT_DEFAULT_ENGINE_BASE_URL,
  type SiftConfig,
} from '../config/index.js';
import type { MockPlannerResponse } from '../planner-protocol/mock-response.js';
import { countTokensWithFallbackDetailed } from '../repo-search/prompt-budget.js';
import type { PersistedChatTranscriptMessage, ThroughputAuditOperation } from '@siftkit/contracts';
import { calculateThroughputRates, emptyInferenceThroughput, mergeInferenceThroughput } from '../lib/inference-throughput.js';
import type { ChatSession } from '../state/chat-sessions.js';
import { auditInferenceThroughput } from './inference-throughput-audit.js';

const CHAT_TOKEN_COUNT_TIMEOUT_MS = 1_000;

/** Canonical session fold over completed answer rows with measured throughput. */
export function buildChatSessionThroughput(messages: readonly PersistedChatTranscriptMessage[]) {
  const throughput = mergeInferenceThroughput(messages
    .filter(message => message.role === 'assistant' && message.kind === 'assistant_answer' && message.throughput != null)
    .map(message => message.throughput ?? emptyInferenceThroughput()));
  return { throughput, rates: calculateThroughputRates(throughput) };
}

/** Audits the completed session aggregate once at the write boundary. */
export function auditCompletedChatSessionThroughput(
  session: ChatSession,
  identity: Pick<ThroughputAuditOperation, 'requestId' | 'model' | 'presetId'>,
): void {
  const aggregate = buildChatSessionThroughput(session.messages ?? []);
  auditInferenceThroughput(
    {
      operationType: 'chat',
      operationId: session.id,
      requestId: identity.requestId,
      stage: 'chat_session',
      model: identity.model,
      presetId: identity.presetId,
      scope: 'published',
    },
    aggregate.throughput,
    { pp: aggregate.rates.promptTokensPerSecond, decode: aggregate.rates.generationTokensPerSecond },
  );
}

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

import { ChatSessionSchema, ChatSessionResponseSchema, ChatSessionSummarySchema, PersistedChatTranscriptMessageSchema, type ChatRecoveryReport } from '@siftkit/contracts';
import type { SiftConfig } from '../config/types.js';
import type { ChatSession, StoredChatSessionSummary } from '../state/chat-sessions.js';
import { buildChatPromptContext } from './chat-prompt-context.js';
import { buildContextUsage, resolveChatSessionContextWindow, resolveChatSessionModel } from './chat.js';
import { buildChatSessionThroughput } from './chat-turn-telemetry.js';

export function withPromptContext(config: SiftConfig, session: ChatSession): ChatSession {
  return { ...session, promptContext: buildChatPromptContext(config, session) };
}

/**
 * The persisted session plus the three fields the wire derives rather than stores. The schema owns
 * the field list, so a new session column reaches the wire with its own edit; `modelPreset` is the
 * request-shaping payload the detail never renders, so it is the one field dropped on the way out.
 */
export function toWireChatSession(config: SiftConfig, session: ChatSession) {
  const messages = (session.messages ?? []).map(message => PersistedChatTranscriptMessageSchema.parse({ ...message, sourceRunId: message.sourceRunId ?? null }));
  const { modelPreset: _requestShapingPreset, ...persisted } = session;
  return ChatSessionSchema.parse({
    ...persisted,
    messages,
    model: resolveChatSessionModel(config, session),
    contextWindowTokens: resolveChatSessionContextWindow(config, session),
    sessionThroughput: buildChatSessionThroughput(messages).rates,
  });
}

/** The rail's row: the state summary as the wire schema declares it, which keeps the config out of the listing. */
export function toWireChatSessionSummary(summary: StoredChatSessionSummary) {
  return ChatSessionSummarySchema.parse(summary);
}

export function buildChatSessionResponse(config: SiftConfig, session: ChatSession, recovery: readonly ChatRecoveryReport[] = []) {
  const readableSession = recovery.some(report => report.status === 'recovery_failed') ? session : withPromptContext(config, session);
  return ChatSessionResponseSchema.parse({ session: toWireChatSession(config, readableSession), contextUsage: buildContextUsage(config, session), recovery });
}

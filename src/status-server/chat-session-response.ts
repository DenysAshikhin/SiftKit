import { ChatSessionSchema, ChatSessionResponseSchema, PersistedChatTranscriptMessageSchema, type ChatRecoveryReport } from '@siftkit/contracts';
import type { SiftConfig } from '../config/types.js';
import type { ChatSession } from '../state/chat-sessions.js';
import { buildChatPromptContext } from './chat-prompt-context.js';
import { buildContextUsage, resolveChatSessionContextWindow, resolveChatSessionModel } from './chat.js';

export function withPromptContext(config: SiftConfig, session: ChatSession): ChatSession {
  return { ...session, promptContext: buildChatPromptContext(config, session) };
}

export function toWireChatSession(config: SiftConfig, session: ChatSession) {
  return ChatSessionSchema.parse({
    id: session.id, title: session.title, modelPresetId: session.modelPresetId,
    model: resolveChatSessionModel(config, session), contextWindowTokens: resolveChatSessionContextWindow(config, session),
    thinkingEnabled: session.thinkingEnabled, webSearchEnabled: session.webSearchEnabled, presetId: session.presetId,
    mode: session.mode, planRepoRoot: session.planRepoRoot, createdAtUtc: session.createdAtUtc, updatedAtUtc: session.updatedAtUtc,
    messages: (session.messages ?? []).map(message => PersistedChatTranscriptMessageSchema.parse({ ...message, sourceRunId: message.sourceRunId ?? null })),
    promptContext: session.promptContext,
  });
}

export function buildChatSessionResponse(config: SiftConfig, session: ChatSession, recovery: readonly ChatRecoveryReport[] = []) {
  const readableSession = recovery.some(report => report.status === 'recovery_failed') ? session : withPromptContext(config, session);
  return ChatSessionResponseSchema.parse({ session: toWireChatSession(config, readableSession), contextUsage: buildContextUsage(config, session), recovery });
}

import { join } from 'node:path';

import { ChatSessionSchema, ChatSessionResponseSchema, ChatSessionSummarySchema, PersistedChatTranscriptMessageSchema, type ChatRecoveryReport, type PersistedChatTranscriptMessage } from '@siftkit/contracts';
import type { SiftConfig } from '../config/types.ts';
import { readChatMeasuredContext, type ChatSession, type StoredChatSessionSummary } from '../state/chat-sessions.ts';
import { buildChatPromptContext } from './chat-prompt-context.ts';
import { buildContextUsage, resolveChatPreviewConfig } from './chat.ts';
import { getActiveModelPreset, getConfiguredEngineNumCtx } from '../config/getters.ts';
import { buildChatSessionThroughput } from './chat-turn-telemetry.ts';
import { calculateThroughputRates } from '../lib/inference-throughput.ts';
import { OrchestratorRunStore } from '../orchestrator/run-store.ts';
import { getRuntimeDatabase } from '../state/runtime-db.ts';

export function withPromptContext(config: SiftConfig, session: ChatSession): ChatSession {
  return { ...session, promptContext: buildChatPromptContext(config, session) };
}

/** A run's session has no chat turns; its rates are the run's parent phases and children. */
function readSessionThroughputRates(runtimeRoot: string, session: ChatSession, messages: readonly PersistedChatTranscriptMessage[]) {
  if (session.orchestratorRunId === null) return buildChatSessionThroughput(messages).rates;
  const store = new OrchestratorRunStore(getRuntimeDatabase(join(runtimeRoot, 'runtime.sqlite')));
  return calculateThroughputRates(store.readThroughput(session.orchestratorRunId));
}

/** Adds the resolved model choices, context capacity and throughput to the persisted transcript. */
function toWireChatSession(config: SiftConfig, runtimeRoot: string, session: ChatSession) {
  const messages = (session.messages ?? []).map(message => PersistedChatTranscriptMessageSchema.parse({ ...message, sourceRunId: message.sourceRunId ?? null }));
  const { modelPreset: _requestShapingPreset, ...persisted } = session;
  const effectiveConfig = resolveChatPreviewConfig(config, session);
  const selected = getActiveModelPreset(effectiveConfig);
  const defaultPreset = session.modelPresetOverrideId === null ? selected
    : getActiveModelPreset(resolveChatPreviewConfig(config, { ...session, modelPresetOverrideId: null }));
  const model = selected.Model?.trim();
  if (!model) throw new Error(`Chat session ${session.id} resolves to a model preset without a model.`);
  return ChatSessionSchema.parse({
    ...persisted,
    messages,
    model,
    defaultModelPreset: { id: defaultPreset.id, label: defaultPreset.label },
    contextWindowTokens: getConfiguredEngineNumCtx(effectiveConfig),
    sessionThroughput: readSessionThroughputRates(runtimeRoot, session, messages),
  });
}

/** The rail's row: the state summary as the wire schema declares it, which keeps the config out of the listing. */
export function toWireChatSessionSummary(summary: StoredChatSessionSummary) {
  return ChatSessionSummarySchema.parse(summary);
}

export function buildChatSessionResponse(config: SiftConfig, runtimeRoot: string, session: ChatSession, recovery: readonly ChatRecoveryReport[] = []) {
  const readableSession = recovery.some(report => report.status === 'recovery_failed') ? session : withPromptContext(config, session);
  const contextUsage = buildContextUsage(config, session, readChatMeasuredContext(runtimeRoot, session.id));
  return ChatSessionResponseSchema.parse({ session: toWireChatSession(config, runtimeRoot, readableSession), contextUsage, recovery });
}

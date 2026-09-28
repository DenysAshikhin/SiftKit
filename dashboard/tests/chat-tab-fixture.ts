import React from 'react';
import { ChatTranscriptMessageSchema } from '@siftkit/contracts';
import type { ChatMessage, ChatSession, DashboardPreset } from '../src/types';
import { ChatRuntimeHub } from '../src/lib/chat-runtime-hub';
import { ChatSessionRuntimeStore } from '../src/lib/chat-session-runtime-store';
import { summarizeChatSession } from '../src/hooks/useChatSessions';
import { ChatTab } from '../src/tabs/ChatTab';

/** Props and sessions for rendering the real ChatTab; browser-safe, so the overflow page shares them. */
export const PRESET = {
  id: 'chat-default', label: 'Chat', description: '', presetKind: 'chat', operationMode: 'full',
  promptPrefix: '', allowedTools: [], surfaces: ['cli', 'web'],
  useForSummary: false, builtin: true, deletable: false, includeAgentsMd: false,
  includeRepoFileListing: false, assistantMemory: false,
  autoloadFiles: [], repoRootRequired: false, maxTurns: null, modelPresetId: null, orchestrator: null,
} satisfies DashboardPreset;

export const REPO_AGENT_PRESET = {
  ...PRESET,
  id: 'repo-agent',
  label: 'Repo Agent',
  presetKind: 'repo-agent',
  operationMode: 'full',
  repoRootRequired: true,
} satisfies DashboardPreset;

/** A transcript row over assistant defaults, validated so an impossible row fails where it is built. */
export function msg(overrides: Partial<ChatMessage>): ChatMessage {
  return ChatTranscriptMessageSchema.parse({
    id: 'm1', role: 'assistant', content: '',
    inputTokensEstimate: 0, outputTokensEstimate: 0, thinkingTokens: 0,
    createdAtUtc: '2026-07-19T00:00:00Z', sourceRunId: null,
    ...overrides,
  });
}

export const SESSION_A = {
  id: 'session-a', title: 'Session A', modelPresetId: 'test-model', model: 'test-model', contextWindowTokens: 100, planRepoRoot: 'C:/repo',
  thinkingEnabled: true, presetId: PRESET.id, mode: 'chat',  createdAtUtc: '2026-04-16T11:00:00.000Z', updatedAtUtc: '2026-04-16T12:00:00.000Z',
  sessionThroughput: { promptTokensPerSecond: null, generationTokensPerSecond: null },
  messages: [msg({ id: 'a1', kind: 'assistant_answer', content: 'Hello from the assistant.' })],
} satisfies ChatSession;

export const SESSION_B = {
  ...SESSION_A,
  id: 'session-b',
  title: 'Session B',
  messages: [],
} satisfies ChatSession;

export type ChatTabProps = React.ComponentProps<typeof ChatTab>;

export function buildDefaultStore(sessionId: string): ChatSessionRuntimeStore {
  return new ChatSessionRuntimeStore()
    .ensureSession('session-a', '')
    .ensureSession('session-b', '')
    .ensureSession(sessionId, '')
    .apply({ kind: 'draft', sessionId, draft: 'hi' });
}

export function buildProps(overrides: Partial<ChatTabProps> = {}): ChatTabProps {
  const selectedSessionId = overrides.selectedSessionId ?? SESSION_A.id;
  const defaultStore = buildDefaultStore(selectedSessionId);
  const props: ChatTabProps = {
    sessions: [summarizeChatSession(SESSION_A), summarizeChatSession(SESSION_B)],
    selectedSessionId,
    selectedSession: selectedSessionId === SESSION_B.id ? SESSION_B : SESSION_A,
    selectedSessionLoading: false,
    runtimeHub: new ChatRuntimeHub(defaultStore),
    sessionPromptCacheStats: { cacheHitRate: 0, promptCacheTokens: 0, promptEvalTokens: 0, acceptanceRate: null, speculativeAcceptedTokens: 0, speculativeGeneratedTokens: 0, promptTokensPerSecond: null, generationTokensPerSecond: null },
    lastTurnTelemetry: { promptTokensPerSecond: null, generationTokensPerSecond: null, ttftMs: null },
    webPresets: [PRESET],
    selectedChatPreset: PRESET,
    chatMode: 'chat',
    isDirectChatMode: true,
    isRepoToolMode: false,
    isThinkingEnabledForCurrentSession: true,
    webSearchEnabled: true,
    showSettings: false,
    onSelectSession: () => {}, onToggleSettings: () => {}, onChangePlanRepoRoot: () => {}, onChangePlanMaxTurns: () => {},
    onChangeDraft: () => {}, onCreateSession: async () => {}, onDeleteSession: async () => {},
    onUpdateSessionPreset: async () => {}, onToggleThinking: async () => {}, onToggleWebSearchEnabled: async () => {},
    onSavePlanRepoRoot: async () => {}, onDeleteMessage: async () => {}, onDeleteTurn: async () => {},
    onDeleteMessageImage: async () => {}, onCondense: async () => {},
    onSendPlan: async () => {}, onSendRepoSearch: async () => {}, onSendMessage: async () => {},
    onSendRepoAgent: async () => {}, onSubmitRepoAgentDecision: async () => {}, onAnswerQuestion: async () => {},
    onChangeRepoAgentApprovalMode: async () => {},
    onStopOperation: async () => {},
    onForceQueue: async () => {},
    onLoadQueueMessage: async (id) => ({ message: { id, content: '', revision: 1, imageCount: 0 } }),
    onEditQueueMessage: async () => {}, onRemoveQueueMessage: async () => {},
    onPendingImagesChange: () => {},
    onPendingImagesAppend: () => {},
    onPendingImageError: () => {},
    ...overrides,
  };
  return props;
}

export const ORCHESTRATOR_CHAT_PRESET = { ...REPO_AGENT_PRESET, id: 'orchestrator', label: 'Orchestrator', presetKind: 'orchestrator',
  operationMode: 'read-only', orchestrator: { maxSubagents: 1 } } satisfies DashboardPreset;
export const ORCHESTRATOR_RUN_ID = '4f9c1f9a-0000-4000-8000-0000000000aa';

export function orchestratorProps(overrides: Partial<ChatTabProps> = {}): ChatTabProps {
  return buildProps({ chatMode: 'orchestrator', isRepoToolMode: true, isDirectChatMode: false,
    webPresets: [ORCHESTRATOR_CHAT_PRESET], selectedChatPreset: ORCHESTRATOR_CHAT_PRESET, ...overrides });
}

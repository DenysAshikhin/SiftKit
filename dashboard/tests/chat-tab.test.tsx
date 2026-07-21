import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ChatTab } from '../src/tabs/ChatTab';
import type { ChatMessage, ChatSession, ContextUsage, DashboardPreset } from '../src/types';

const PRESET = {
  id: 'chat-default', label: 'Chat', description: '', presetKind: 'chat', operationMode: 'full',
  executionFamily: 'chat', promptPrefix: '', allowedTools: [], surfaces: ['cli', 'web'],
  useForSummary: false, builtin: true, deletable: false, includeAgentsMd: false,
  includeRepoFileListing: false, repoRootRequired: false, maxTurns: null,
} satisfies DashboardPreset;

function msg(overrides: Partial<ChatMessage>): ChatMessage {
  return {
    id: 'm1', role: 'assistant', content: '',
    inputTokensEstimate: 0, outputTokensEstimate: 0, thinkingTokens: 0,
    createdAtUtc: '2026-07-19T00:00:00Z', sourceRunId: null,
    ...overrides,
  };
}

const SESSION = {
  id: 'session-1', title: 'Session', model: 'test-model', contextWindowTokens: 100,
  thinkingEnabled: true, presetId: PRESET.id, mode: 'chat', condensedSummary: '',
  createdAtUtc: '2026-04-16T11:00:00.000Z', updatedAtUtc: '2026-04-16T12:00:00.000Z',
  messages: [msg({ id: 'a1', kind: 'assistant_answer', content: 'Hello from the assistant.' })],
} satisfies ChatSession;

const CONTEXT_USAGE = {
  shouldCondense: false, chatUsedTokens: 90, thinkingUsedTokens: 0, toolUsedTokens: 0,
  totalUsedTokens: 90, remainingTokens: 10, warnThresholdTokens: 50, contextWindowTokens: 100,
  usedTokens: 90, estimatedTokenFallbackTokens: 0, providerOverheadTokens: 5,
} satisfies ContextUsage;

type ChatTabProps = React.ComponentProps<typeof ChatTab>;

function render(overrides: Partial<ChatTabProps> = {}): string {
  const baseSession = overrides.selectedSession ?? SESSION;
  const props: ChatTabProps = {
    sessions: overrides.sessions ?? [baseSession],
    selectedSessionId: overrides.selectedSessionId ?? baseSession.id,
    selectedSession: baseSession,
    sessionPromptCacheStats: { cacheHitRate: 0, promptCacheTokens: 0, promptEvalTokens: 0, acceptanceRate: null, speculativeAcceptedTokens: 0, speculativeGeneratedTokens: 0, promptTokensPerSecond: null, generationTokensPerSecond: null },
    webPresets: overrides.webPresets ?? [PRESET],
    selectedChatPreset: overrides.selectedChatPreset ?? PRESET,
    chatMode: overrides.chatMode ?? 'chat',
    isDirectChatMode: overrides.isDirectChatMode ?? true,
    isRepoToolMode: overrides.isRepoToolMode ?? false,
    isThinkingEnabledForCurrentSession: overrides.isThinkingEnabledForCurrentSession ?? true,
    webSearchEnabled: overrides.webSearchEnabled ?? true,
    showSettings: overrides.showSettings ?? false,
    planRepoRootInput: overrides.planRepoRootInput ?? '',
    contextUsage: overrides.contextUsage ?? CONTEXT_USAGE,
    liveToolPromptTokenCount: overrides.liveToolPromptTokenCount ?? null,
    repoSearchAutoAppendPreview: overrides.repoSearchAutoAppendPreview ?? null,
    repoSearchAutoAppendSelection: overrides.repoSearchAutoAppendSelection ?? { includeAgentsMd: true, includeRepoFileListing: true },
    isRepoSearchAutoAppendPreviewLoading: overrides.isRepoSearchAutoAppendPreviewLoading ?? false,
    liveMessages: overrides.liveMessages ?? [],
    chatInput: overrides.chatInput ?? 'hi',
    chatBusy: overrides.chatBusy ?? false,
    chatError: overrides.chatError ?? null,
    onSelectSession: () => {}, onToggleSettings: () => {}, onChangePlanRepoRoot: () => {}, onChangeChatInput: () => {},
    onSetRepoSearchAutoAppendSelection: () => {}, onCreateSession: async () => {}, onDeleteSession: async () => {},
    onUpdateSessionPreset: async () => {}, onToggleThinking: async () => {}, onToggleWebSearchEnabled: async () => {},
    onSavePlanRepoRoot: async () => {}, onDeleteMessage: async () => {}, onDeleteTurn: async () => {}, onCondense: async () => {},
    onSendPlan: async () => {}, onSendRepoSearch: async () => {}, onSendMessage: async () => {},
    ...overrides,
  };
  return renderToStaticMarkup(React.createElement(ChatTab, props));
}

test('chat tab renders session lane, chat head with hchips, msgs and composer', () => {
  const markup = render();
  assert.match(markup, /class="chat-lane"/);
  assert.match(markup, /New session/);
  assert.match(markup, /class="chat-head"/);
  assert.match(markup, /class="hchip on"[^>]*>web search/);
  assert.match(markup, /class="hchip on"[^>]*>per-step thinking/);
  assert.match(markup, /class="msgs"/);
  assert.match(markup, /class="composer"/);
  assert.match(markup, /<select/);
});

test('session lane shows a streaming indicator for the active busy session', () => {
  const markup = render({
    chatBusy: true,
    liveMessages: [msg({ id: 'live', kind: 'assistant_answer', content: 'partial' })],
  });
  assert.match(markup, /class="typing"/);
  assert.match(markup, /caret/);
});

test('a running tool message renders a ToolCallCard with spinner', () => {
  const markup = render({
    chatBusy: true,
    liveMessages: [msg({ id: 'tool', kind: 'assistant_tool_call', toolCallCommand: 'grep "x"', toolCallStatus: 'running' })],
  });
  assert.match(markup, /class="tcall"/);
  assert.match(markup, /class="sp"/);
});

test('send button keeps its honest label and is disabled while busy, over an 85% warn context bar', () => {
  const markup = render({ chatBusy: true });
  assert.match(markup, /class="send"[^>]*disabled[^>]*>Send/);
  assert.doesNotMatch(markup, /class="send"[^>]*>Stop/);
  assert.match(markup, /class="ctx warn"/);
});

test('backend failure renders an error banner with retry and open logs', () => {
  const markup = render({ chatError: 'Backend restart failed' });
  assert.match(markup, /class="err-banner"/);
  assert.match(markup, /Backend restart failed/);
  assert.match(markup, /Retry/);
  assert.match(markup, /Open logs/);
});

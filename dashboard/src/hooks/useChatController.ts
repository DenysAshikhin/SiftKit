import { useState } from 'react';
import { getDefaultWebPresetId, getPresetById, getPresetFamily, getSurfacePresets } from '../dashboard-presets';
import { getSessionTelemetryStats, readSearchParams } from '../lib/format';
import { getErrorMessage } from '../../../src/lib/errors.js';
import { useChatSessions } from './useChatSessions';
import { useChatComposer } from './useChatComposer';
import type { DashboardConfig } from '../types';
import type { ChatTabProps } from '../tabs/ChatTab';

export type ChatController = {
  tabProps: ChatTabProps;
  selectedSessionId: string;
};

export function useChatController(deps: {
  refreshToken: number;
  dashboardConfig: DashboardConfig | null;
  requestDashboardDataRefresh: () => void;
  refreshSelectedRunDetail: () => Promise<void>;
}): ChatController {
  const params = readSearchParams();
  const [showSettings, setShowSettings] = useState(false);

  const chatSessionsHook = useChatSessions({
    initialSelectedSessionId: params.get('session') || '',
    refreshToken: deps.refreshToken,
    buildCreateSessionRequest: () => {
      const presetId = getDefaultWebPresetId(deps.dashboardConfig);
      return presetId
        ? { title: `Session ${new Date().toLocaleTimeString()}`, presetId }
        : null;
    },
    confirmDeleteSession: () => window.confirm('Delete this chat session permanently?'),
  });

  const selectedSession = chatSessionsHook.selectedSession;
  const isThinkingEnabledForCurrentSession = selectedSession?.thinkingEnabled !== false;
  const webPresets = getSurfacePresets(deps.dashboardConfig, 'web');
  const selectedChatPreset = getPresetById(deps.dashboardConfig, selectedSession?.presetId);
  const chatMode = getPresetFamily(deps.dashboardConfig, selectedSession);
  const isDirectChatMode = chatMode === 'chat' || chatMode === 'summary';
  const isRepoToolMode = chatMode === 'plan' || chatMode === 'repo-search';
  const sessionPromptCacheStats = getSessionTelemetryStats(selectedSession);

  const selectedRuntime = chatSessionsHook.selectedSessionId
    ? (() => {
        try {
          return chatSessionsHook.runtimeStore.get(chatSessionsHook.selectedSessionId);
        } catch {
          return null;
        }
      })()
    : null;

  const composer = useChatComposer({
    selectedSession,
    draft: selectedRuntime?.draft ?? '',
    pendingImages: selectedRuntime?.pendingImages ?? [],
    planRepoRootInput: selectedRuntime?.planRepoRootInput ?? '',
    planMaxTurnsInput: selectedRuntime?.planMaxTurnsInput ?? '',
    isThinkingEnabledForCurrentSession,
    runtimes: {
      beginSessionOperation: chatSessionsHook.beginSessionOperation,
      appendSessionThinking: chatSessionsHook.appendSessionThinking,
      applySessionToolEvent: chatSessionsHook.applySessionToolEvent,
      applySessionAnswer: chatSessionsHook.applySessionAnswer,
      applySessionWarning: chatSessionsHook.applySessionWarning,
      completeSessionOperation: chatSessionsHook.completeSessionOperation,
      failSessionOperation: chatSessionsHook.failSessionOperation,
    },
  });

  async function refreshAfterChatMessageMutation(): Promise<void> {
    deps.requestDashboardDataRefresh();
    try {
      await deps.refreshSelectedRunDetail();
    } catch (error) {
      if (chatSessionsHook.selectedSessionId) {
        chatSessionsHook.failSessionOperation(chatSessionsHook.selectedSessionId, getErrorMessage(error));
      }
    }
  }

  async function onDeleteChatMessage(messageId: string): Promise<void> {
    const response = await chatSessionsHook.deleteMessage(messageId);
    if (!response) {
      return;
    }
    await refreshAfterChatMessageMutation();
  }

  async function onDeleteChatTurn(messageIds: string[]): Promise<void> {
    const response = await chatSessionsHook.deleteMessages(messageIds);
    if (!response) {
      return;
    }
    await refreshAfterChatMessageMutation();
  }

  const tabProps: ChatTabProps = {
    sessions: chatSessionsHook.sessions,
    selectedSessionId: chatSessionsHook.selectedSessionId,
    selectedSession,
    selectedRuntime,
    sessionRuntimes: chatSessionsHook.runtimeStore.getAll(),
    sessionPromptCacheStats,
    webPresets,
    selectedChatPreset,
    chatMode,
    isDirectChatMode,
    isRepoToolMode,
    isThinkingEnabledForCurrentSession,
    webSearchEnabled: selectedSession?.webSearchEnabled === true,
    showSettings,
    onSelectSession: chatSessionsHook.selectSession,
    onToggleSettings: () => setShowSettings((prev) => !prev),
    onChangePlanRepoRoot: (value: string) => {
      if (chatSessionsHook.selectedSessionId) {
        chatSessionsHook.setSessionPlanInputs(chatSessionsHook.selectedSessionId, value, selectedRuntime?.planMaxTurnsInput ?? '');
      }
    },
    onCreateSession: chatSessionsHook.createSession,
    onDeleteSession: chatSessionsHook.deleteSession,
    onUpdateSessionPreset: chatSessionsHook.updateSessionPreset,
    onToggleThinking: chatSessionsHook.toggleThinking,
    onToggleWebSearchEnabled: chatSessionsHook.toggleWebSearch,
    onSavePlanRepoRoot: () => chatSessionsHook.savePlanRepoRoot(selectedRuntime?.planRepoRootInput ?? '', selectedChatPreset?.id),
    onDeleteMessage: onDeleteChatMessage,
    onDeleteTurn: onDeleteChatTurn,
    onCondense: chatSessionsHook.condense,
    onSendPlan: composer.sendPlan,
    onSendRepoSearch: composer.sendRepoSearch,
    onSendMessage: composer.sendMessage,
    onPendingImagesChange: (images: string[]) => {
      if (chatSessionsHook.selectedSessionId) {
        chatSessionsHook.setSessionImages(chatSessionsHook.selectedSessionId, images);
      }
    },
    onChangeDraft: (value: string) => {
      if (chatSessionsHook.selectedSessionId) {
        chatSessionsHook.setSessionDraft(chatSessionsHook.selectedSessionId, value);
      }
    },
  };

  return { tabProps, selectedSessionId: chatSessionsHook.selectedSessionId };
}

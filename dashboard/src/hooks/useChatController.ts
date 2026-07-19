import { useState } from 'react';
import { getDefaultWebPresetId, getPresetById, getPresetFamily, getSurfacePresets } from '../dashboard-presets';
import { getSessionTelemetryStats, readSearchParams } from '../lib/format';
import { getErrorMessage } from '../../../src/lib/errors.js';
import { useChatSessions } from './useChatSessions';
import { useLiveMessages } from './useLiveMessages';
import { useContextUsage } from './useContextUsage';
import { usePlanInputs } from './usePlanInputs';
import { useRepoSearchAutoAppend } from './useRepoSearchAutoAppend';
import { useChatComposer } from './useChatComposer';
import type { DashboardConfig } from '../types';
import type { ChatTabProps } from '../tabs/ChatTab';

export type ChatController = {
  tabProps: ChatTabProps;
  selectedSessionId: string;
};

function getActiveModel(config: DashboardConfig | null): string {
  if (!config) return 'Qwen3.5-9B-Q8_0.gguf';
  const modelPresets = config.Server.ModelPresets;
  const preset = modelPresets.Presets.find((entry) => entry.id === modelPresets.ActivePresetId)
    ?? modelPresets.Presets[0];
  return preset?.Model || 'Qwen3.5-9B-Q8_0.gguf';
}

export function useChatController(deps: {
  refreshToken: number;
  dashboardConfig: DashboardConfig | null;
  maintainPerStepThinkingForCurrentPreset: boolean;
  requestDashboardDataRefresh: () => void;
  refreshSelectedRunDetail: () => Promise<void>;
}): ChatController {
  const params = readSearchParams();
  const [chatError, setChatError] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);

  const live = useLiveMessages();
  const contextHook = useContextUsage();
  const chatSessionsHook = useChatSessions({
    onError: (error) => setChatError(getErrorMessage(error)),
    initialSelectedSessionId: params.get('session') || '',
    refreshToken: deps.refreshToken,
    buildCreateSessionRequest: () => ({
      title: `Session ${new Date().toLocaleTimeString()}`,
      model: getActiveModel(deps.dashboardConfig),
      presetId: getDefaultWebPresetId(deps.dashboardConfig),
    }),
    confirmDeleteSession: () => window.confirm('Delete this chat session permanently?'),
    applyContextUsage: contextHook.setContextUsage,
  });

  const selectedSession = chatSessionsHook.selectedSession;
  const isThinkingEnabledForCurrentSession = selectedSession?.thinkingEnabled !== false;
  const webPresets = getSurfacePresets(deps.dashboardConfig, 'web');
  const selectedChatPreset = getPresetById(deps.dashboardConfig, selectedSession?.presetId)
    || getPresetById(deps.dashboardConfig, selectedSession?.mode)
    || webPresets[0]
    || null;
  const chatMode = getPresetFamily(deps.dashboardConfig, selectedSession);
  const isDirectChatMode = chatMode === 'chat' || chatMode === 'summary';
  const isRepoToolMode = chatMode === 'plan' || chatMode === 'repo-search';
  const sessionPromptCacheStats = getSessionTelemetryStats(selectedSession);

  const planInputs = usePlanInputs({
    selectedSession,
    selectedChatPreset,
  });

  const autoAppend = useRepoSearchAutoAppend({
    selectedSession,
    chatMode,
    planRepoRootInput: planInputs.planRepoRootInput,
    liveMessages: live.liveMessages,
    onError: (error) => setChatError(getErrorMessage(error)),
  });

  const composer = useChatComposer({
    selectedSession,
    selectedChatPreset,
    live,
    context: contextHook,
    refreshSessions: chatSessionsHook.refreshSessions,
    applySessionResponse: chatSessionsHook.applySessionResponse,
    planRepoRootInput: planInputs.planRepoRootInput,
    planMaxTurnsInput: planInputs.planMaxTurnsInput,
    isThinkingEnabledForCurrentSession,
    maintainPerStepThinkingForCurrentPreset: deps.maintainPerStepThinkingForCurrentPreset,
    repoSearchAutoAppendSelection: autoAppend.selection,
    onError: (message) => setChatError(message),
    resetError: () => setChatError(null),
    setChatBusy: chatSessionsHook.setChatBusy,
  });

  async function refreshAfterChatMessageMutation(): Promise<void> {
    deps.requestDashboardDataRefresh();
    try {
      await deps.refreshSelectedRunDetail();
    } catch (error) {
      setChatError(getErrorMessage(error));
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
    sessionPromptCacheStats,
    webPresets,
    selectedChatPreset,
    chatMode,
    isDirectChatMode,
    isRepoToolMode,
    isThinkingEnabledForCurrentSession,
    webSearchEnabled: selectedSession?.webSearchEnabled === true,
    showSettings,
    planRepoRootInput: planInputs.planRepoRootInput,
    contextUsage: contextHook.contextUsage,
    liveToolPromptTokenCount: contextHook.liveToolPromptTokenCount,
    repoSearchAutoAppendPreview: autoAppend.preview,
    repoSearchAutoAppendSelection: autoAppend.selection,
    isRepoSearchAutoAppendPreviewLoading: autoAppend.previewLoading,
    liveMessages: live.liveMessages,
    chatInput: composer.chatInput,
    chatBusy: chatSessionsHook.chatBusy,
    chatError,
    onSelectSession: chatSessionsHook.selectSession,
    onToggleSettings: () => setShowSettings((prev) => !prev),
    onChangePlanRepoRoot: planInputs.setPlanRepoRootInput,
    onChangeChatInput: composer.setChatInput,
    onSetRepoSearchAutoAppendSelection: autoAppend.setSelection,
    onCreateSession: chatSessionsHook.createSession,
    onDeleteSession: chatSessionsHook.deleteSession,
    onUpdateSessionPreset: chatSessionsHook.updateSessionPreset,
    onToggleThinking: chatSessionsHook.toggleThinking,
    onToggleWebSearchEnabled: chatSessionsHook.toggleWebSearch,
    onSavePlanRepoRoot: () => chatSessionsHook.savePlanRepoRoot(planInputs.planRepoRootInput, selectedChatPreset?.id),
    onDeleteMessage: onDeleteChatMessage,
    onDeleteTurn: onDeleteChatTurn,
    onCondense: chatSessionsHook.condense,
    onSendPlan: composer.sendPlan,
    onSendRepoSearch: composer.sendRepoSearch,
    onSendMessage: composer.sendMessage,
  };

  return { tabProps, selectedSessionId: chatSessionsHook.selectedSessionId };
}

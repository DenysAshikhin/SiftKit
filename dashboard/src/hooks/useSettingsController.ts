import { useEffect, useState } from 'react';
import {
  getDashboardConfig,
  getDashboardHealth,
  pickManagedFile,
  restartBackend,
  testLlamaCppBaseUrl as testLlamaCppBaseUrlRequest,
  updateDashboardConfig,
} from '../api';
import { createPresetIdFromLabel } from '../dashboard-presets';
import {
  getFallbackPresetId,
  getNextPresetIdAfterDelete,
} from '../preset-editor';
import {
  DashboardSettingsDraftEditor,
  type DashboardSettingsDraftAction,
} from '../settings-draft-editor';
import type {
  AssistantSettingsActions,
  GeneralSettingsActions,
  InteractiveSettingsActions,
  ModelPresetSettingsActions,
  PresetSettingsActions,
  ToolPolicySettingsActions,
  WebSearchSettingsActions,
} from '../settings-action-groups';
import {
  getDirtyActionRequirement,
  isBackendRestartSupported,
  type DirtyContinuation,
  type ModelPresetPathField,
  type SettingsPathPickerBusyTarget,
} from '../settings-flow';
import { type SettingsSectionId } from '../settings-sections';
import { buildManagedLlamaRestartFailureModal } from '../managed-llama-restart';
import { cloneDashboardConfig, getDashboardConfigSignature } from '../lib/format';
import type { ManagedFilePickerTarget } from '@siftkit/contracts';
import type {
  DashboardConfig,
  DashboardModelRuntimePreset,
  ProviderQuota,
  WebSearchUsage,
} from '../types';
import type { SettingsTabProps } from '../tabs/SettingsTab';
import type { ToastLevel } from './useToasts';

type DashboardTabKey = 'runs' | 'metrics' | 'benchmark' | 'chat' | 'assistant' | 'settings';

export function createUniquePresetId(existingPresets: ReadonlyArray<{ id: string }>, label: string): string {
  const baseId = createPresetIdFromLabel(label);
  if (!existingPresets.some((preset) => preset.id === baseId)) {
    return baseId;
  }
  let counter = 2;
  while (existingPresets.some((preset) => preset.id === `${baseId}-${counter}`)) {
    counter += 1;
  }
  return `${baseId}-${counter}`;
}

export type SettingsController = {
  tabProps: SettingsTabProps;
  dashboardConfig: DashboardConfig | null;
  selectedModelPreset: DashboardModelRuntimePreset | null;
  maintainPerStepThinkingForCurrentPreset: boolean;
  settingsDirty: boolean;
  restartFailureModal: { title: string; message: string } | null;
  confirm: {
    show: boolean;
    saving: boolean;
    actionBusy: boolean;
    onSave(): Promise<void>;
    onDiscard(): void;
    onCancel(): void;
  };
  closeRestartFailureModal(): void;
  onRequestTabChange(nextTab: DashboardTabKey): void;
  restartDashboardBackendCore(): Promise<boolean>;
};

export function useSettingsController(deps: {
  enqueueToast: (level: ToastLevel, text: string) => void;
  requestDashboardDataRefresh: () => void;
  tab: string;
  webSearchUsage: WebSearchUsage | null;
  webSearchQuota: ProviderQuota[] | null;
  onSwitchTab: (tab: DashboardTabKey) => void;
}): SettingsController {
  const [dashboardConfig, setDashboardConfig] = useState<DashboardConfig | null>(null);
  const [savedDashboardConfig, setSavedDashboardConfig] = useState<DashboardConfig | null>(null);
  const [settingsLoading, setSettingsLoading] = useState(false);
  const [settingsSaving, setSettingsSaving] = useState(false);
  const [settingsRestarting, setSettingsRestarting] = useState(false);
  const [settingsPathPickerBusyTarget, setSettingsPathPickerBusyTarget] = useState<SettingsPathPickerBusyTarget | null>(null);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [settingsSavedAtUtc, setSettingsSavedAtUtc] = useState<string | null>(null);
  const [activeSettingsSection, setActiveSettingsSection] = useState<SettingsSectionId>('general');
  const [selectedSettingsPresetId, setSelectedSettingsPresetId] = useState<string | null>(null);
  const [pendingSettingsContinuation, setPendingSettingsContinuation] = useState<DirtyContinuation | null>(null);
  const [showSettingsConfirm, setShowSettingsConfirm] = useState(false);
  const [settingsRestartFailureModal, setSettingsRestartFailureModal] = useState<{ title: string; message: string } | null>(null);

  const settingsDirty = dashboardConfig !== null
    && savedDashboardConfig !== null
    && getDashboardConfigSignature(dashboardConfig) !== getDashboardConfigSignature(savedDashboardConfig);
  const settingsActionBusy = settingsLoading || settingsSaving || settingsRestarting || settingsPathPickerBusyTarget !== null;
  const selectedSettingsPreset = dashboardConfig
    ? dashboardConfig.Presets.find((preset) => preset.id === selectedSettingsPresetId) ?? dashboardConfig.Presets[0] ?? null
    : null;
  const selectedModelPreset = dashboardConfig
    ? dashboardConfig.Server.ModelPresets.Presets.find((preset) => preset.id === dashboardConfig.Server.ModelPresets.ActivePresetId)
      ?? dashboardConfig.Server.ModelPresets.Presets[0]
      ?? null
    : null;
  const settingsRestartSupported = isBackendRestartSupported(selectedModelPreset);
  const maintainPerStepThinkingForCurrentPreset = selectedModelPreset?.Reasoning === 'on'
    ? selectedModelPreset.MaintainPerStepThinking !== false
    : false;

  useEffect(() => {
    if (deps.tab !== 'settings' && dashboardConfig !== null) {
      return;
    }
    let cancelled = false;
    async function refreshConfig() {
      setSettingsLoading(true);
      setSettingsError(null);
      try {
        const response = await getDashboardConfig();
        if (!cancelled) {
          const synced = cloneDashboardConfig(response);
          setDashboardConfig(synced);
          setSavedDashboardConfig(cloneDashboardConfig(synced));
        }
      } catch (error) {
        if (!cancelled) {
          setSettingsError(error instanceof Error ? error.message : String(error));
        }
      } finally {
        if (!cancelled) {
          setSettingsLoading(false);
        }
      }
    }
    void refreshConfig();
    return () => { cancelled = true; };
  }, [deps.tab]);

  useEffect(() => {
    setSelectedSettingsPresetId((previous) => getFallbackPresetId(dashboardConfig?.Presets ?? [], previous));
  }, [dashboardConfig]);

  useEffect(() => {
    const handleBeforeUnload = (event: BeforeUnloadEvent): void => {
      if (deps.tab !== 'settings' || !settingsDirty) {
        return;
      }
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => {
      window.removeEventListener('beforeunload', handleBeforeUnload);
    };
  }, [settingsDirty, deps.tab]);

  function applySettingsAction(action: DashboardSettingsDraftAction): void {
    setDashboardConfig((previous) => {
      if (!previous) {
        return previous;
      }
      const editor = new DashboardSettingsDraftEditor(previous);
      editor.apply(action);
      return editor.getConfig();
    });
    setSettingsSavedAtUtc(null);
  }

  function getSelectedModelPresetId(): string | null {
    return selectedModelPreset?.id ?? null;
  }

  const generalActions: GeneralSettingsActions = {
    setString(field, value) {
      applySettingsAction({ type: 'set-general-string', field, value });
    },
    setBoolean(field, value) {
      applySettingsAction({ type: 'set-general-boolean', field, value });
    },
  };

  const toolPolicyActions: ToolPolicySettingsActions = {
    setToolEnabled(operationMode, tool, enabled) {
      applySettingsAction({ type: 'set-operation-tool-enabled', operationMode, tool, enabled });
    },
  };

  const presetActions: PresetSettingsActions = {
    selectPreset(presetId) {
      setSelectedSettingsPresetId(presetId);
    },
    setString(presetId, field, value) {
      applySettingsAction({ type: 'set-preset-string', presetId, field, value });
    },
    setKind(presetId, value) {
      applySettingsAction({ type: 'set-preset-kind', presetId, value });
    },
    setOperationMode(presetId, value) {
      applySettingsAction({ type: 'set-preset-operation-mode', presetId, value });
    },
    setToolEnabled(presetId, tool, enabled) {
      applySettingsAction({ type: 'set-preset-tool-enabled', presetId, tool, enabled });
    },
    setSurfaceEnabled(presetId, surface, enabled) {
      applySettingsAction({ type: 'set-preset-surface-enabled', presetId, surface, enabled });
    },
    setAgentsMdEnabled(presetId, enabled) {
      applySettingsAction({ type: 'set-preset-boolean', presetId, field: 'includeAgentsMd', value: enabled });
    },
    setRepoFileListingEnabled(presetId, enabled) {
      applySettingsAction({ type: 'set-preset-boolean', presetId, field: 'includeRepoFileListing', value: enabled });
    },
    setAssistantMemoryEnabled(presetId, enabled) {
      applySettingsAction({ type: 'set-preset-boolean', presetId, field: 'assistantMemory', value: enabled });
    },
    setAutoloadFile(presetId, index, value) {
      applySettingsAction({ type: 'set-preset-autoload-file', presetId, index, value });
    },
    pickAutoloadFile(presetId, index) {
      return onPickPresetAutoloadFile(presetId, index);
    },
    addAutoloadFile(presetId) {
      applySettingsAction({ type: 'add-preset-autoload-file', presetId });
    },
    removeAutoloadFile(presetId, index) {
      applySettingsAction({ type: 'remove-preset-autoload-file', presetId, index });
    },
    setSummaryDefault(presetId) {
      applySettingsAction({ type: 'set-summary-default-preset', presetId });
    },
    addPreset() {
      if (!dashboardConfig) {
        return;
      }
      const presetId = createUniquePresetId(
        dashboardConfig.Presets,
        `custom-preset-${dashboardConfig.Presets.length + 1}`,
      );
      const label = `Custom Preset ${Math.max(
        1,
        dashboardConfig.Presets.filter((preset) => preset.deletable).length + 1,
      )}`;
      applySettingsAction({ type: 'add-preset', presetId, label });
      setSelectedSettingsPresetId(presetId);
    },
    deletePreset(presetId) {
      if (!dashboardConfig) {
        return;
      }
      const nextPresetId = getNextPresetIdAfterDelete(dashboardConfig.Presets, presetId);
      applySettingsAction({ type: 'delete-preset', presetId });
      setSelectedSettingsPresetId(nextPresetId);
    },
  };

  const interactiveActions: InteractiveSettingsActions = {
    setThreshold(field, value) {
      applySettingsAction({ type: 'set-threshold-integer', field, value });
    },
    setInteger(field, value) {
      applySettingsAction({ type: 'set-interactive-integer', field, value });
    },
    setBoolean(field, value) {
      applySettingsAction({ type: 'set-interactive-boolean', field, value });
    },
    setWrappedCommands(value) {
      applySettingsAction({ type: 'set-interactive-wrapped-commands', value });
    },
  };

  const webSearchActions: WebSearchSettingsActions = {
    setPrimaryProvider(provider) {
      applySettingsAction({ type: 'set-web-search-primary-provider', provider });
    },
    setEnabledDefault(value) {
      applySettingsAction({ type: 'set-web-search-enabled-default', value });
    },
    setProviderEnabled(provider, value) {
      applySettingsAction({ type: 'set-web-search-provider-enabled', provider, value });
    },
    setProviderApiKey(provider, value) {
      applySettingsAction({ type: 'set-web-search-provider-api-key', provider, value });
    },
    setInteger(field, value) {
      applySettingsAction({ type: 'set-web-search-integer', field, value });
    },
  };

  const modelPresetActions: ModelPresetSettingsActions = {
    selectPreset(presetId) {
      applySettingsAction({ type: 'set-active-model-preset', presetId });
    },
    setString(field, value) {
      const presetId = getSelectedModelPresetId();
      if (presetId) applySettingsAction({ type: 'set-model-string', presetId, field, value });
    },
    setNullableString(field, value) {
      const presetId = getSelectedModelPresetId();
      if (presetId) applySettingsAction({ type: 'set-model-nullable-string', presetId, field, value });
    },
    setModelPath(value) {
      const presetId = getSelectedModelPresetId();
      if (presetId) applySettingsAction({ type: 'set-model-path', presetId, value });
    },
    setInteger(field, value) {
      const presetId = getSelectedModelPresetId();
      if (presetId) applySettingsAction({ type: 'set-model-integer', presetId, field, value });
    },
    setFloat(field, value) {
      const presetId = getSelectedModelPresetId();
      if (presetId) applySettingsAction({ type: 'set-model-float', presetId, field, value });
    },
    setBoolean(field, value) {
      const presetId = getSelectedModelPresetId();
      if (presetId) applySettingsAction({ type: 'set-model-boolean', presetId, field, value });
    },
    setBackend(value) {
      const presetId = getSelectedModelPresetId();
      if (presetId) applySettingsAction({ type: 'set-model-backend', presetId, value });
    },
    setIdleAction(value) {
      const presetId = getSelectedModelPresetId();
      if (presetId) applySettingsAction({ type: 'set-model-idle-action', presetId, value });
    },
    setKvCacheQuantization(value) {
      const presetId = getSelectedModelPresetId();
      if (presetId) applySettingsAction({ type: 'set-model-kv-cache-quantization', presetId, value });
    },
    setReasoning(value) {
      const presetId = getSelectedModelPresetId();
      if (presetId) applySettingsAction({ type: 'set-model-reasoning', presetId, value });
    },
    setReasoningContent(value) {
      const presetId = getSelectedModelPresetId();
      if (presetId) applySettingsAction({ type: 'set-model-reasoning-content', presetId, value });
    },
    setSpeculativeType(value) {
      const presetId = getSelectedModelPresetId();
      if (presetId) applySettingsAction({ type: 'set-model-speculative-type', presetId, value });
    },
    addPreset() {
      applySettingsAction({ type: 'add-model-preset' });
    },
    deletePreset(presetId) {
      applySettingsAction({ type: 'delete-model-preset', presetId });
    },
    pickPath(target) {
      return onPickModelPresetPath(target);
    },
    testBaseUrl(baseUrl, timeoutMs) {
      return onTestLlamaCppBaseUrl(baseUrl, timeoutMs);
    },
  };

  const assistantActions: AssistantSettingsActions = {
    replace(value) {
      applySettingsAction({ type: 'set-assistant', value });
    },
  };

  async function saveDashboardSettingsCore(): Promise<boolean> {
    if (!dashboardConfig) {
      return false;
    }
    setSettingsSaving(true);
    setSettingsError(null);
    try {
      const updated = await updateDashboardConfig(dashboardConfig);
      const synced = cloneDashboardConfig(updated);
      setDashboardConfig(synced);
      setSavedDashboardConfig(cloneDashboardConfig(synced));
      setSettingsSavedAtUtc(new Date().toISOString());
      return true;
    } catch (error) {
      setSettingsError(error instanceof Error ? error.message : String(error));
      return false;
    } finally {
      setSettingsSaving(false);
    }
  }

  async function onSaveDashboardSettings(): Promise<void> {
    await saveDashboardSettingsCore();
  }

  async function reloadDashboardSettingsCore(): Promise<boolean> {
    setSettingsLoading(true);
    setSettingsError(null);
    try {
      const response = await getDashboardConfig();
      const synced = cloneDashboardConfig(response);
      setDashboardConfig(synced);
      setSavedDashboardConfig(cloneDashboardConfig(synced));
      setSettingsSavedAtUtc(null);
      return true;
    } catch (error) {
      setSettingsError(error instanceof Error ? error.message : String(error));
      return false;
    } finally {
      setSettingsLoading(false);
    }
  }

  async function onReloadDashboardSettings(): Promise<void> {
    await reloadDashboardSettingsCore();
  }

  async function pickFilePath(
    busyTarget: SettingsPathPickerBusyTarget,
    pickerTarget: ManagedFilePickerTarget,
    initialPath: string | null,
  ): Promise<string | null> {
    setSettingsPathPickerBusyTarget(busyTarget);
    setSettingsError(null);
    try {
      const response = await pickManagedFile(pickerTarget, initialPath);
      return response.cancelled ? null : response.path;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setSettingsError(message);
      deps.enqueueToast('error', `Path picker failed: ${message}`);
      return null;
    } finally {
      setSettingsPathPickerBusyTarget(null);
    }
  }

  async function onPickModelPresetPath(target: ModelPresetPathField): Promise<void> {
    if (!dashboardConfig || !selectedModelPreset) {
      return;
    }
    const picked = await pickFilePath(
      { kind: 'model-preset', field: target },
      target === 'ExecutablePath' ? 'managed-llama-executable' : 'managed-llama-model',
      target === 'ExecutablePath' ? selectedModelPreset.ExecutablePath : selectedModelPreset.ModelPath,
    );
    if (picked === null) {
      return;
    }
    if (target === 'ExecutablePath') {
      modelPresetActions.setNullableString('ExecutablePath', picked);
    } else {
      modelPresetActions.setModelPath(picked);
    }
  }

  async function onPickPresetAutoloadFile(presetId: string, index: number): Promise<void> {
    const preset = dashboardConfig?.Presets.find((entry) => entry.id === presetId);
    if (!preset) {
      return;
    }
    const picked = await pickFilePath(
      { kind: 'preset-autoload', presetId, index },
      'preset-autoload-file',
      preset.autoloadFiles[index] ?? null,
    );
    if (picked === null) {
      return;
    }
    presetActions.setAutoloadFile(presetId, index, picked);
  }

  async function onTestLlamaCppBaseUrl(baseUrl: string, timeoutMs: number): Promise<void> {
    setSettingsError(null);
    try {
      const response = await testLlamaCppBaseUrlRequest(baseUrl, timeoutMs);
      if (!response.ok) {
        throw new Error(response.error || `llama.cpp test failed with status ${response.statusCode}`);
      }
      setSettingsSavedAtUtc(new Date().toISOString());
      deps.enqueueToast('info', `llama.cpp reachable at ${response.baseUrl || baseUrl}.`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setSettingsError(message);
      deps.enqueueToast('error', `llama.cpp test failed: ${message}`);
    }
  }

  function discardDashboardSettingsChanges(): void {
    if (!savedDashboardConfig) {
      return;
    }
    setDashboardConfig(cloneDashboardConfig(savedDashboardConfig));
    setSettingsError(null);
  }

  async function restartDashboardBackendCore(): Promise<boolean> {
    setSettingsRestarting(true);
    setSettingsError(null);
    setSettingsRestartFailureModal(null);
    try {
      const response = await restartBackend();
      if (!response.ok || !response.restarted) {
        const message = response.error || 'Backend restart failed.';
        const modal = buildManagedLlamaRestartFailureModal(response);
        setSettingsError(message);
        if (modal) {
          setSettingsRestartFailureModal(modal);
        }
        deps.enqueueToast('error', `Backend restart failed: ${message}`);
        return false;
      }
      await getDashboardHealth();
      const reloaded = await reloadDashboardSettingsCore();
      if (reloaded) {
        deps.enqueueToast('info', 'Backend restarted.');
      }
      return reloaded;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setSettingsError(message);
      deps.enqueueToast('error', `Backend restart failed: ${message}`);
      return false;
    } finally {
      setSettingsRestarting(false);
    }
  }

  async function continueSettingsAction(continuation: DirtyContinuation): Promise<void> {
    if (continuation.kind === 'switch-section') {
      setActiveSettingsSection(continuation.nextSection);
      return;
    }
    if (continuation.kind === 'switch-tab') {
      deps.onSwitchTab(continuation.nextTab);
      return;
    }
    if (continuation.kind === 'reload-settings') {
      await reloadDashboardSettingsCore();
      return;
    }
    await restartDashboardBackendCore();
  }

  function closeSettingsConfirm(): void {
    setShowSettingsConfirm(false);
    setPendingSettingsContinuation(null);
  }

  function requestSettingsAction(continuation: DirtyContinuation): void {
    if (getDirtyActionRequirement(settingsDirty, continuation.kind) === 'confirm') {
      setPendingSettingsContinuation(continuation);
      setShowSettingsConfirm(true);
      return;
    }
    void continueSettingsAction(continuation);
  }

  async function onConfirmSaveSettingsAction(): Promise<void> {
    if (!pendingSettingsContinuation) {
      return;
    }
    const continuation = pendingSettingsContinuation;
    const saved = await saveDashboardSettingsCore();
    if (!saved) {
      return;
    }
    closeSettingsConfirm();
    await continueSettingsAction(continuation);
  }

  function onConfirmDiscardSettingsAction(): void {
    if (!pendingSettingsContinuation) {
      return;
    }
    const continuation = pendingSettingsContinuation;
    discardDashboardSettingsChanges();
    closeSettingsConfirm();
    void continueSettingsAction(continuation);
  }

  function onRequestTabChange(nextTab: DashboardTabKey): void {
    if (deps.tab === 'settings' && nextTab !== 'settings') {
      requestSettingsAction({ kind: 'switch-tab', nextTab });
      return;
    }
    deps.onSwitchTab(nextTab);
  }

  const tabProps: SettingsTabProps = {
    activeSettingsSection,
    dashboardConfig,
    selectedSettingsPreset,
    selectedModelPreset,
    selectedSettingsPresetId,
    webSearchUsage: deps.webSearchUsage,
    webSearchQuota: deps.webSearchQuota,
    settingsLoading,
    settingsError,
    settingsDirty,
    settingsSavedAtUtc,
    settingsActionBusy,
    settingsRestartSupported,
    settingsSaving,
    settingsRestarting,
    settingsPathPickerBusyTarget,
    requestSettingsAction,
    generalActions,
    toolPolicyActions,
    presetActions,
    interactiveActions,
    webSearchActions,
    modelPresetActions,
    assistantActions,
    onReloadDashboardSettings,
    restartDashboardBackendCore,
    onSaveDashboardSettings,
  };

  return {
    tabProps,
    dashboardConfig,
    selectedModelPreset,
    maintainPerStepThinkingForCurrentPreset,
    settingsDirty,
    restartFailureModal: settingsRestartFailureModal,
    confirm: {
      show: showSettingsConfirm,
      saving: settingsSaving,
      actionBusy: settingsActionBusy,
      onSave: onConfirmSaveSettingsAction,
      onDiscard: onConfirmDiscardSettingsAction,
      onCancel: closeSettingsConfirm,
    },
    closeRestartFailureModal: () => setSettingsRestartFailureModal(null),
    onRequestTabChange,
    restartDashboardBackendCore,
  };
}

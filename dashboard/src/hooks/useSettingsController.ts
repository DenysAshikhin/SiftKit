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
  addModelPreset,
  deleteModelPreset,
  updateActiveModelPreset,
} from '../model-runtime-presets';
import {
  getDefaultToolsForOperationMode,
  getFallbackPresetId,
  getNextPresetIdAfterDelete,
} from '../preset-editor';
import { getDirtyActionRequirement, type DirtyContinuation } from '../settings-flow';
import { type SettingsSectionId } from '../settings-sections';
import { buildManagedLlamaRestartFailureModal } from '../managed-llama-restart';
import { deriveRuntimeModelId, syncDerivedSettingsFields } from '../settings-runtime';
import { cloneDashboardConfig, getDashboardConfigSignature } from '../lib/format';
import type { DashboardConfig, DashboardModelRuntimePreset, DashboardPreset, ProviderQuota, WebSearchUsage } from '../types';
import type { SettingsTabProps } from '../tabs/SettingsTab';
import type { ToastLevel } from './useToasts';

type DashboardTabKey = 'runs' | 'metrics' | 'benchmark' | 'chat' | 'settings';

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
  const [settingsPathPickerBusyTarget, setSettingsPathPickerBusyTarget] = useState<'ExecutablePath' | 'ModelPath' | null>(null);
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
  // Only the managed llama.cpp runtime is restartable from here; exl3 is owned by TabbyAPI.
  const settingsRestartSupported = selectedModelPreset?.Backend === 'llama';
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

  function updateSettingsDraft(updater: (next: DashboardConfig) => void): void {
    setDashboardConfig((previous) => {
      if (!previous) {
        return previous;
      }
      const next = cloneDashboardConfig(previous);
      updater(next);
      return syncDerivedSettingsFields(next);
    });
    setSettingsSavedAtUtc(null);
  }

  function updatePresetDraft(presetId: string, updater: (preset: DashboardPreset) => void): void {
    updateSettingsDraft((next) => {
      const preset = next.Presets.find((entry) => entry.id === presetId);
      if (!preset) {
        return;
      }
      updater(preset);
    });
  }

  function updateModelPresetDraft(updater: (preset: DashboardModelRuntimePreset) => void): void {
    updateSettingsDraft((next) => {
      updateActiveModelPreset(next, updater);
    });
  }

  function onAddPreset(): void {
    let addedPresetId: string | null = null;
    updateSettingsDraft((next) => {
      const id = createUniquePresetId(next.Presets, `custom-preset-${next.Presets.length + 1}`);
      addedPresetId = id;
      next.Presets.push({
        id,
        label: `Custom Preset ${Math.max(1, next.Presets.filter((preset) => preset.deletable).length + 1)}`,
        description: '',
        presetKind: 'summary',
        operationMode: 'summary',
        executionFamily: 'summary',
        promptPrefix: '',
        allowedTools: getDefaultToolsForOperationMode('summary'),
        surfaces: ['cli'],
        useForSummary: false,
        builtin: false,
        deletable: true,
        includeAgentsMd: true,
        includeRepoFileListing: true,
        repoRootRequired: false,
        maxTurns: null,
      });
    });
    setSelectedSettingsPresetId(addedPresetId);
  }

  function onDeletePreset(presetId: string): void {
    let nextPresetId: string | null = null;
    updateSettingsDraft((next) => {
      nextPresetId = getNextPresetIdAfterDelete(next.Presets, presetId);
      next.Presets = next.Presets.filter((preset) => preset.id !== presetId || preset.deletable === false);
    });
    setSelectedSettingsPresetId(nextPresetId);
  }

  function onAddModelPreset(): void {
    updateSettingsDraft((next) => {
      addModelPreset(next);
    });
  }

  function onDeleteModelPreset(presetId: string): void {
    updateSettingsDraft((next) => {
      deleteModelPreset(next, presetId);
    });
  }

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

  async function onPickModelPresetPath(target: 'ExecutablePath' | 'ModelPath'): Promise<void> {
    if (!dashboardConfig || !selectedModelPreset) {
      return;
    }
    const initialPath = target === 'ExecutablePath'
      ? selectedModelPreset.ExecutablePath
      : selectedModelPreset.ModelPath;
    setSettingsPathPickerBusyTarget(target);
    setSettingsError(null);
    try {
      const response = await pickManagedFile(
        target === 'ExecutablePath' ? 'managed-llama-executable' : 'managed-llama-model',
        initialPath,
      );
      if (response.cancelled || !response.path) {
        return;
      }
      updateModelPresetDraft((preset) => {
        if (target === 'ExecutablePath') {
          preset.ExecutablePath = response.path;
          return;
        }
        preset.ModelPath = response.path;
        preset.Model = deriveRuntimeModelId(preset.ModelPath) || preset.Model;
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setSettingsError(message);
      deps.enqueueToast('error', `Path picker failed: ${message}`);
    } finally {
      setSettingsPathPickerBusyTarget(null);
    }
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
    setSelectedSettingsPresetId,
    requestSettingsAction,
    updateSettingsDraft,
    updatePresetDraft,
    updateModelPresetDraft,
    onAddPreset,
    onDeletePreset,
    onAddModelPreset,
    onDeleteModelPreset,
    onPickModelPresetPath,
    onTestLlamaCppBaseUrl,
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

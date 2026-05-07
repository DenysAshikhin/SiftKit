import React from 'react';
import type { ReactNode } from 'react';

import {
  applyOperationModeDefaults,
  applyPresetKindDefaults,
  getEffectivePresetTools,
  PRESET_TOOL_DESCRIPTIONS,
  PRESET_TOOL_OPTIONS,
  getPresetToolsSummary,
  togglePresetTool,
} from '../preset-editor';
import { formatDate, parseFloatInput, parseIntegerInput } from '../lib/format';
import { applyManagedLlamaPresetSelection } from '../managed-llama-presets';
import type { DirtyContinuation } from '../settings-flow';
import {
  POLICY_MODE_OPTIONS,
  SETTINGS_SECTION_ORDER,
  SETTINGS_SECTIONS,
  getSettingsFieldDescriptor,
  type SettingsSectionId,
} from '../settings-sections';
import { SettingsField, SettingsInlineHelpLabel } from '../settings/SettingsFields';
import type { DashboardConfig, DashboardManagedLlamaPreset, DashboardPreset } from '../types';
import { PresetsSection } from './settings/PresetsSection';
import { ManagedLlamaSection } from './settings/ManagedLlamaSection';

type SettingsTabProps = {
  activeSettingsSection: SettingsSectionId;
  dashboardConfig: DashboardConfig | null;
  selectedSettingsPreset: DashboardPreset | null;
  selectedManagedLlamaPreset: DashboardManagedLlamaPreset | null;
  selectedSettingsPresetId: string | null;
  settingsLoading: boolean;
  settingsError: string | null;
  settingsDirty: boolean;
  settingsSavedAtUtc: string | null;
  settingsActionBusy: boolean;
  settingsRestartSupported: boolean;
  settingsSaving: boolean;
  settingsRestarting: boolean;
  settingsPathPickerBusyTarget: 'ExecutablePath' | 'ModelPath' | null;
  setSelectedSettingsPresetId(presetId: string): void;
  requestSettingsAction(continuation: DirtyContinuation): void;
  updateSettingsDraft(updater: (next: DashboardConfig) => void): void;
  updatePresetDraft(presetId: string, updater: (preset: DashboardPreset) => void): void;
  updateManagedLlamaDraft(updater: (preset: DashboardManagedLlamaPreset) => void): void;
  onAddPreset(): void;
  onDeletePreset(presetId: string): void;
  onAddManagedLlamaPreset(): void;
  onDeleteManagedLlamaPreset(presetId: string): void;
  onPickManagedLlamaPath(target: 'ExecutablePath' | 'ModelPath'): Promise<void>;
  onTestLlamaCppBaseUrl(baseUrl: string, timeoutMs: number): Promise<void>;
  onReloadDashboardSettings(): Promise<void>;
  restartDashboardBackendCore(): Promise<boolean>;
  onSaveDashboardSettings(): Promise<void>;
};

export function SettingsTab(props: SettingsTabProps) {
  const {
    activeSettingsSection,
    dashboardConfig,
    selectedSettingsPreset,
    selectedManagedLlamaPreset,
    selectedSettingsPresetId,
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
    updateManagedLlamaDraft,
    onAddPreset,
    onDeletePreset,
    onAddManagedLlamaPreset,
    onDeleteManagedLlamaPreset,
    onPickManagedLlamaPath,
    onTestLlamaCppBaseUrl,
    onReloadDashboardSettings,
    restartDashboardBackendCore,
    onSaveDashboardSettings,
  } = props;

  const renderField = (
    sectionId: SettingsSectionId,
    label: string,
    children: ReactNode,
    className?: string,
  ): ReactNode => {
    const field = getSettingsFieldDescriptor(sectionId, label);
    return (
      <SettingsField key={label} label={label} layout={field.layout} helpText={field.helpText} className={className}>
        {children}
      </SettingsField>
    );
  };

  const renderGeneralSection = (): ReactNode => {
    if (!dashboardConfig) {
      return null;
    }
    return (
      <div className="settings-live-grid">
        {renderField('general', 'Version', (
          <input
            value={dashboardConfig.Version}
            onChange={(event) => updateSettingsDraft((next) => { next.Version = event.target.value; })}
          />
        ))}
        {renderField('general', 'Backend', (
          <div className="settings-live-nav-control">
            <input value={dashboardConfig.Backend} readOnly />
            <button
              type="button"
              onClick={() => requestSettingsAction({ kind: 'switch-section', nextSection: 'model-presets' })}
            >
              Open Model Presets
            </button>
          </div>
        ))}
        {renderField('general', 'Policy Mode', (
          <select
            value={dashboardConfig.PolicyMode}
            onChange={(event) => updateSettingsDraft((next) => { next.PolicyMode = event.target.value; })}
          >
            {POLICY_MODE_OPTIONS.map((option) => (
              <option key={option} value={option}>{option}</option>
            ))}
          </select>
        ))}
        {renderField('general', 'Raw log retention', (
          <label className="settings-live-toggle-control">
            <input
              type="checkbox"
              checked={dashboardConfig.RawLogRetention}
              onChange={(event) => updateSettingsDraft((next) => { next.RawLogRetention = event.target.checked; })}
            />
            <span>{dashboardConfig.RawLogRetention ? 'Enabled' : 'Disabled'}</span>
          </label>
        ))}
        {renderField('general', 'Initial repo file scan', (
          <label className="settings-live-toggle-control">
            <input
              type="checkbox"
              checked={dashboardConfig.IncludeRepoFileListing}
              onChange={(event) => updateSettingsDraft((next) => { next.IncludeRepoFileListing = event.target.checked; })}
            />
            <span>{dashboardConfig.IncludeRepoFileListing ? 'Enabled' : 'Disabled'}</span>
          </label>
        ))}
        {renderField('general', 'Prompt prefix', (
          <textarea
            rows={5}
            value={dashboardConfig.PromptPrefix || ''}
            onChange={(event) => updateSettingsDraft((next) => { next.PromptPrefix = event.target.value; })}
          />
        ))}
      </div>
    );
  };

  const renderToolPolicySection = (): ReactNode => {
    if (!dashboardConfig) {
      return null;
    }
    return (
      <div className="settings-live-grid">
        {renderField('tool-policy', 'Operation mode tool policy', (
          <div className="settings-preset-mode-grid">
            {(['summary', 'read-only', 'full'] as const).map((operationMode) => (
              <div key={operationMode} className="settings-preset-mode-card">
                <span className="settings-preset-mode-title">
                  <SettingsInlineHelpLabel
                    label={operationMode}
                    helpText={`Globally allowed tools for ${operationMode} mode.`}
                  />
                </span>
                <div className="settings-preset-tools-list compact">
                  {PRESET_TOOL_OPTIONS.map((tool) => (
                    <label key={`${operationMode}-${tool}`} className="settings-preset-tools-option" tabIndex={0}>
                      <input
                        type="checkbox"
                        checked={dashboardConfig.OperationModeAllowedTools[operationMode].includes(tool)}
                        onChange={() => updateSettingsDraft((next) => {
                          next.OperationModeAllowedTools[operationMode] = togglePresetTool(
                            next.OperationModeAllowedTools[operationMode],
                            tool,
                          );
                        })}
                      />
                      <span className="settings-preset-tools-option-label">{tool}</span>
                      <span className="settings-preset-tools-option-popover" role="tooltip">
                        <strong>{tool}</strong>
                        {PRESET_TOOL_DESCRIPTIONS[tool]}
                      </span>
                    </label>
                  ))}
                </div>
              </div>
            ))}
          </div>
        ))}
      </div>
    );
  };

  const renderInteractiveSection = (): ReactNode => {
    if (!dashboardConfig) {
      return null;
    }
    return (
      <div className="settings-live-grid">
        {renderField('interactive', 'MinCharsForSummary', (
          <input
            type="number"
            value={dashboardConfig.Thresholds.MinCharactersForSummary}
            onChange={(event) => updateSettingsDraft((next) => {
              next.Thresholds.MinCharactersForSummary = parseIntegerInput(event.target.value, next.Thresholds.MinCharactersForSummary);
            })}
          />
        ))}
        {renderField('interactive', 'MinLinesForSummary', (
          <input
            type="number"
            value={dashboardConfig.Thresholds.MinLinesForSummary}
            onChange={(event) => updateSettingsDraft((next) => {
              next.Thresholds.MinLinesForSummary = parseIntegerInput(event.target.value, next.Thresholds.MinLinesForSummary);
            })}
          />
        ))}
        {renderField('interactive', 'Interactive IdleTimeoutMs', (
          <input
            type="number"
            value={dashboardConfig.Interactive.IdleTimeoutMs}
            onChange={(event) => updateSettingsDraft((next) => {
              next.Interactive.IdleTimeoutMs = parseIntegerInput(event.target.value, next.Interactive.IdleTimeoutMs);
            })}
          />
        ))}
        {renderField('interactive', 'MaxTranscriptChars', (
          <input
            type="number"
            value={dashboardConfig.Interactive.MaxTranscriptCharacters}
            onChange={(event) => updateSettingsDraft((next) => {
              next.Interactive.MaxTranscriptCharacters = parseIntegerInput(event.target.value, next.Interactive.MaxTranscriptCharacters);
            })}
          />
        ))}
        {renderField('interactive', 'Wrapped commands', (
          <textarea
            rows={4}
            value={dashboardConfig.Interactive.WrappedCommands.join(', ')}
            onChange={(event) => updateSettingsDraft((next) => {
              next.Interactive.WrappedCommands = event.target.value
                .split(',')
                .map((entry) => entry.trim())
                .filter(Boolean);
            })}
          />
        ))}
        {renderField('interactive', 'Interactive enabled', (
          <label className="settings-live-toggle-control">
            <input
              type="checkbox"
              checked={dashboardConfig.Interactive.Enabled}
              onChange={(event) => updateSettingsDraft((next) => { next.Interactive.Enabled = event.target.checked; })}
            />
            <span>{dashboardConfig.Interactive.Enabled ? 'Enabled' : 'Disabled'}</span>
          </label>
        ))}
        {renderField('interactive', 'Interactive transcript retention', (
          <label className="settings-live-toggle-control">
            <input
              type="checkbox"
              checked={dashboardConfig.Interactive.TranscriptRetention}
              onChange={(event) => updateSettingsDraft((next) => { next.Interactive.TranscriptRetention = event.target.checked; })}
            />
            <span>{dashboardConfig.Interactive.TranscriptRetention ? 'Enabled' : 'Disabled'}</span>
          </label>
        ))}
      </div>
    );
  };

  const renderSettingsSection = (): ReactNode => {
    if (activeSettingsSection === 'general') return renderGeneralSection();
    if (activeSettingsSection === 'tool-policy') return renderToolPolicySection();
    if (activeSettingsSection === 'presets') {
      return (
        <PresetsSection
          dashboardConfig={dashboardConfig}
          selectedSettingsPreset={selectedSettingsPreset}
          selectedSettingsPresetId={selectedSettingsPresetId}
          renderField={renderField}
          setSelectedSettingsPresetId={setSelectedSettingsPresetId}
          updateSettingsDraft={updateSettingsDraft}
          updatePresetDraft={updatePresetDraft}
          onAddPreset={onAddPreset}
          onDeletePreset={onDeletePreset}
        />
      );
    }
    if (activeSettingsSection === 'interactive') return renderInteractiveSection();
    return (
      <ManagedLlamaSection
        dashboardConfig={dashboardConfig}
        selectedManagedLlamaPreset={selectedManagedLlamaPreset}
        settingsActionBusy={settingsActionBusy}
        settingsPathPickerBusyTarget={settingsPathPickerBusyTarget}
        renderField={renderField}
        updateSettingsDraft={updateSettingsDraft}
        updateManagedLlamaDraft={updateManagedLlamaDraft}
        onAddManagedLlamaPreset={onAddManagedLlamaPreset}
        onDeleteManagedLlamaPreset={onDeleteManagedLlamaPreset}
        onPickManagedLlamaPath={onPickManagedLlamaPath}
        onTestLlamaCppBaseUrl={onTestLlamaCppBaseUrl}
      />
    );
  };

  return (
    <section className="panel-grid settings-live-layout">
      <section className="panel settings-live-rail-panel">
        <h2>Settings</h2>
        <p className="hint">One section at a time. Unsaved changes are guarded before switching away.</p>
        <div className="settings-live-rail">
          {SETTINGS_SECTION_ORDER.map((sectionId) => {
            const section = SETTINGS_SECTIONS[sectionId];
            return (
              <button
                key={section.id}
                type="button"
                className={activeSettingsSection === section.id ? 'settings-live-rail-button active' : 'settings-live-rail-button'}
                onClick={() => {
                  if (activeSettingsSection !== section.id) {
                    requestSettingsAction({ kind: 'switch-section', nextSection: section.id });
                  }
                }}
              >
                <span className="settings-live-section-icon">{section.icon}</span>
                <span>
                  <strong>{section.title}</strong>
                  <span>{section.summary}</span>
                </span>
              </button>
            );
          })}
        </div>
      </section>
      <section className="panel settings-live-panel">
        {settingsLoading && <p className="hint">Loading config...</p>}
        {settingsError && <p className="error">{settingsError}</p>}
        {dashboardConfig && (
          <>
            <div className="settings-live-section-header">
              <div>
                <span className="settings-live-section-icon active">{SETTINGS_SECTIONS[activeSettingsSection].icon}</span>
                <div>
                  <h2>{SETTINGS_SECTIONS[activeSettingsSection].title}</h2>
                  <p className="hint">{SETTINGS_SECTIONS[activeSettingsSection].summary}</p>
                </div>
              </div>
              <div className="settings-live-status">
                <span className={settingsDirty ? 'settings-live-dirty on' : 'settings-live-dirty'}>
                  {settingsDirty ? 'Unsaved changes' : 'All changes saved'}
                </span>
                {settingsSavedAtUtc && <span className="hint">Saved {formatDate(settingsSavedAtUtc)}</span>}
              </div>
            </div>
            <div className="settings-live-section-body">{renderSettingsSection()}</div>
            <div className="settings-live-actionbar">
              <button
                type="button"
                onClick={() => {
                  if (settingsDirty) {
                    requestSettingsAction({ kind: 'reload-settings' });
                    return;
                  }
                  void onReloadDashboardSettings();
                }}
                disabled={settingsActionBusy}
              >
                Reload
              </button>
              <button
                type="button"
                onClick={() => {
                  if (settingsDirty) {
                    requestSettingsAction({ kind: 'restart-backend' });
                    return;
                  }
                  void restartDashboardBackendCore();
                }}
                disabled={settingsActionBusy || !settingsRestartSupported}
              >
                {settingsRestarting ? 'Restarting...' : 'Restart Backend'}
              </button>
              <button type="button" className="settings-live-save-button" onClick={() => { void onSaveDashboardSettings(); }} disabled={settingsActionBusy}>
                {settingsSaving ? 'Saving...' : 'Save Settings'}
              </button>
            </div>
          </>
        )}
      </section>
    </section>
  );
}

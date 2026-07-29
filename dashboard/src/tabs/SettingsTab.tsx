import React from 'react';
import type { ReactNode } from 'react';

import { formatDate, formatNumber, parseIntegerInput } from '../lib/format';
import type { DirtyContinuation, SettingsPathPickerBusyTarget } from '../settings-flow';
import {
  POLICY_MODE_OPTIONS,
  SETTINGS_SECTION_ORDER,
  SETTINGS_SECTIONS,
  type SettingsSectionId,
} from '../settings-sections';
import { SettingsSectionField } from '../settings/SettingsFields';
import type {
  DashboardConfig,
  DashboardModelRuntimePreset,
  DashboardPreset,
  ProviderQuota,
  WebSearchUsage,
} from '../types';
import type {
  GeneralSettingsActions,
  InteractiveSettingsActions,
  ModelPresetSettingsActions,
  PresetSettingsActions,
  ToolPolicySettingsActions,
  WebSearchSettingsActions,
} from '../settings-action-groups';
import { PresetsSection } from './settings/PresetsSection';
import { ModelPresetsSection } from './settings/ModelPresetsSection';
import { ToolPolicyMatrix } from './settings/ToolPolicyMatrix';

export type SettingsTabProps = {
  activeSettingsSection: SettingsSectionId;
  dashboardConfig: DashboardConfig | null;
  selectedSettingsPreset: DashboardPreset | null;
  selectedModelPreset: DashboardModelRuntimePreset | null;
  selectedSettingsPresetId: string | null;
  webSearchUsage: WebSearchUsage | null;
  webSearchQuota: ProviderQuota[] | null;
  settingsLoading: boolean;
  settingsError: string | null;
  settingsDirty: boolean;
  settingsSavedAtUtc: string | null;
  settingsActionBusy: boolean;
  settingsRestartSupported: boolean;
  settingsSaving: boolean;
  settingsRestarting: boolean;
  settingsPathPickerBusyTarget: SettingsPathPickerBusyTarget | null;
  requestSettingsAction(continuation: DirtyContinuation): void;
  generalActions: GeneralSettingsActions;
  toolPolicyActions: ToolPolicySettingsActions;
  presetActions: PresetSettingsActions;
  interactiveActions: InteractiveSettingsActions;
  webSearchActions: WebSearchSettingsActions;
  modelPresetActions: ModelPresetSettingsActions;
  onReloadDashboardSettings(): Promise<void>;
  restartDashboardBackendCore(): Promise<boolean>;
  onSaveDashboardSettings(): Promise<void>;
};

export function SettingsTab(props: SettingsTabProps) {
  const {
    activeSettingsSection,
    dashboardConfig,
    selectedSettingsPreset,
    selectedModelPreset,
    selectedSettingsPresetId,
    webSearchUsage,
    webSearchQuota,
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
    onReloadDashboardSettings,
    restartDashboardBackendCore,
    onSaveDashboardSettings,
  } = props;

  const [showTavilyKey, setShowTavilyKey] = React.useState(false);
  const [showFirecrawlKey, setShowFirecrawlKey] = React.useState(false);

  const renderField = (
    sectionId: SettingsSectionId,
    label: string,
    children: ReactNode,
    className?: string,
  ): ReactNode => (
    <SettingsSectionField key={label} sectionId={sectionId} label={label} className={className}>
      {children}
    </SettingsSectionField>
  );

  const renderGeneralSection = (): ReactNode => {
    if (!dashboardConfig) {
      return null;
    }
    return (
      <div className="fgrid">
        {renderField('general', 'Version', (
          <input
            value={dashboardConfig.Version}
            onChange={(event) => generalActions.setString('Version', event.target.value)}
          />
        ))}
        {renderField('general', 'Backend', (
          <div className="settings-live-nav-control">
            <input value={selectedModelPreset?.Backend ?? ''} readOnly />
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
            onChange={(event) => generalActions.setString('PolicyMode', event.target.value)}
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
              onChange={(event) => generalActions.setBoolean('RawLogRetention', event.target.checked)}
            />
            <span>{dashboardConfig.RawLogRetention ? 'Enabled' : 'Disabled'}</span>
          </label>
        ))}
        {renderField('general', 'Expand reads', (
          <label className="settings-live-toggle-control">
            <input
              type="checkbox"
              checked={dashboardConfig.ExpandReads}
              onChange={(event) => generalActions.setBoolean('ExpandReads', event.target.checked)}
            />
            <span>{dashboardConfig.ExpandReads ? 'Enabled' : 'Disabled'}</span>
          </label>
        ))}
        {renderField('general', 'Prompt prefix', (
          <textarea
            rows={5}
            value={dashboardConfig.PromptPrefix || ''}
            onChange={(event) => generalActions.setString('PromptPrefix', event.target.value)}
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
      <ToolPolicyMatrix allowed={dashboardConfig.OperationModeAllowedTools} toolPolicyActions={toolPolicyActions} />
    );
  };

  const renderInteractiveSection = (): ReactNode => {
    if (!dashboardConfig) {
      return null;
    }
    return (
      <div className="fgrid">
        {renderField('interactive', 'MinCharsForSummary', (
          <input
            type="number"
            value={dashboardConfig.Thresholds.MinCharactersForSummary}
            onChange={(event) => interactiveActions.setThreshold(
              'MinCharactersForSummary',
              parseIntegerInput(event.target.value, dashboardConfig.Thresholds.MinCharactersForSummary),
            )}
          />
        ))}
        {renderField('interactive', 'MinLinesForSummary', (
          <input
            type="number"
            value={dashboardConfig.Thresholds.MinLinesForSummary}
            onChange={(event) => interactiveActions.setThreshold(
              'MinLinesForSummary',
              parseIntegerInput(event.target.value, dashboardConfig.Thresholds.MinLinesForSummary),
            )}
          />
        ))}
        {renderField('interactive', 'Interactive IdleTimeoutMs', (
          <input
            type="number"
            value={dashboardConfig.Interactive.IdleTimeoutMs}
            onChange={(event) => interactiveActions.setInteger(
              'IdleTimeoutMs',
              parseIntegerInput(event.target.value, dashboardConfig.Interactive.IdleTimeoutMs),
            )}
          />
        ))}
        {renderField('interactive', 'MaxTranscriptChars', (
          <input
            type="number"
            value={dashboardConfig.Interactive.MaxTranscriptCharacters}
            onChange={(event) => interactiveActions.setInteger(
              'MaxTranscriptCharacters',
              parseIntegerInput(event.target.value, dashboardConfig.Interactive.MaxTranscriptCharacters),
            )}
          />
        ))}
        {renderField('interactive', 'Wrapped commands', (
          <textarea
            rows={4}
            value={dashboardConfig.Interactive.WrappedCommands.join(', ')}
            onChange={(event) => interactiveActions.setWrappedCommands(
              event.target.value
                .split(',')
                .map((entry) => entry.trim())
                .filter(Boolean),
            )}
          />
        ))}
        {renderField('interactive', 'Interactive enabled', (
          <label className="settings-live-toggle-control">
            <input
              type="checkbox"
              checked={dashboardConfig.Interactive.Enabled}
              onChange={(event) => interactiveActions.setBoolean('Enabled', event.target.checked)}
            />
            <span>{dashboardConfig.Interactive.Enabled ? 'Enabled' : 'Disabled'}</span>
          </label>
        ))}
        {renderField('interactive', 'Interactive transcript retention', (
          <label className="settings-live-toggle-control">
            <input
              type="checkbox"
              checked={dashboardConfig.Interactive.TranscriptRetention}
              onChange={(event) => interactiveActions.setBoolean('TranscriptRetention', event.target.checked)}
            />
            <span>{dashboardConfig.Interactive.TranscriptRetention ? 'Enabled' : 'Disabled'}</span>
          </label>
        ))}
      </div>
    );
  };

  const renderWebSearchSection = (): ReactNode => {
    if (!dashboardConfig) {
      return null;
    }
    const web = dashboardConfig.WebSearch;
    return (
      <div className="fgrid">
        {renderField('web-search', 'Primary provider', (
          <select
            value={web.ProviderOrder[0]}
            onChange={(event) => webSearchActions.setPrimaryProvider(
              event.target.value === 'firecrawl' ? 'firecrawl' : 'tavily',
            )}
          >
            <option value="tavily">tavily</option>
            <option value="firecrawl">firecrawl</option>
          </select>
        ))}
        {renderField('web-search', 'Web search enabled by default', (
          <label className="settings-live-toggle-control">
            <input
              type="checkbox"
              checked={web.EnabledDefault}
              onChange={(event) => webSearchActions.setEnabledDefault(event.target.checked)}
            />
            <span>{web.EnabledDefault ? 'Enabled' : 'Disabled'}</span>
          </label>
        ))}
        {renderField('web-search', 'Tavily enabled', (
          <label className="settings-live-toggle-control">
            <input
              type="checkbox"
              checked={web.Providers.tavily.Enabled}
              onChange={(event) => webSearchActions.setProviderEnabled('tavily', event.target.checked)}
            />
            <span>{web.Providers.tavily.Enabled ? 'Enabled' : 'Disabled'}</span>
          </label>
        ))}
        {renderField('web-search', 'Tavily API key', (
          <div className="settings-live-nav-control">
            <input
              type={showTavilyKey ? 'text' : 'password'}
              value={web.Providers.tavily.ApiKey}
              onChange={(event) => webSearchActions.setProviderApiKey('tavily', event.target.value)}
            />
            <button type="button" onClick={() => setShowTavilyKey((value) => !value)}>
              {showTavilyKey ? 'Hide' : 'Show'}
            </button>
          </div>
        ))}
        {renderField('web-search', 'Firecrawl enabled', (
          <label className="settings-live-toggle-control">
            <input
              type="checkbox"
              checked={web.Providers.firecrawl.Enabled}
              onChange={(event) => webSearchActions.setProviderEnabled('firecrawl', event.target.checked)}
            />
            <span>{web.Providers.firecrawl.Enabled ? 'Enabled' : 'Disabled'}</span>
          </label>
        ))}
        {renderField('web-search', 'Firecrawl API key', (
          <div className="settings-live-nav-control">
            <input
              type={showFirecrawlKey ? 'text' : 'password'}
              value={web.Providers.firecrawl.ApiKey}
              onChange={(event) => webSearchActions.setProviderApiKey('firecrawl', event.target.value)}
            />
            <button type="button" onClick={() => setShowFirecrawlKey((value) => !value)}>
              {showFirecrawlKey ? 'Hide' : 'Show'}
            </button>
          </div>
        ))}
        {renderField('web-search', 'Result count', (
          <input
            type="number"
            value={web.ResultCount}
            onChange={(event) => webSearchActions.setInteger('ResultCount', parseIntegerInput(event.target.value, web.ResultCount))}
          />
        ))}
        {renderField('web-search', 'Timeout ms', (
          <input
            type="number"
            value={web.TimeoutMs}
            onChange={(event) => webSearchActions.setInteger('TimeoutMs', parseIntegerInput(event.target.value, web.TimeoutMs))}
          />
        ))}
        {renderField('web-search', 'Fetch max pages', (
          <input
            type="number"
            value={web.FetchMaxPages}
            onChange={(event) => webSearchActions.setInteger('FetchMaxPages', parseIntegerInput(event.target.value, web.FetchMaxPages))}
          />
        ))}
        {renderField('web-search', 'Fetch max characters', (
          <input
            type="number"
            value={web.FetchMaxCharacters}
            onChange={(event) => webSearchActions.setInteger('FetchMaxCharacters', parseIntegerInput(event.target.value, web.FetchMaxCharacters))}
          />
        ))}
        {renderField('web-search', 'Usage', (
          <span>
            {webSearchUsage
              ? `${formatNumber(webSearchUsage.currentMonthCount)} this month (${webSearchUsage.currentMonth}) / ${formatNumber(webSearchUsage.allTimeCount)} all-time`
              : 'No usage recorded yet.'}
            {(webSearchQuota ?? []).map((quota) => (
              <span key={quota.provider} style={{ display: 'block' }}>
                {`${quota.provider}: ${quota.remaining ?? '?'} left of ${quota.limit ?? '?'} (used ${quota.used ?? '?'})`}
              </span>
            ))}
          </span>
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
          settingsActionBusy={settingsActionBusy}
          settingsPathPickerBusyTarget={settingsPathPickerBusyTarget}
          presetActions={presetActions}
        />
      );
    }
    if (activeSettingsSection === 'interactive') return renderInteractiveSection();
    if (activeSettingsSection === 'web-search') return renderWebSearchSection();
    return (
      <ModelPresetsSection
        dashboardConfig={dashboardConfig}
        selectedModelPreset={selectedModelPreset}
        settingsActionBusy={settingsActionBusy}
        settingsPathPickerBusyTarget={settingsPathPickerBusyTarget}
        modelPresetActions={modelPresetActions}
      />
    );
  };

  const activeSection = SETTINGS_SECTIONS[activeSettingsSection];

  return (
    <>
      <div className="set-nav">
        {SETTINGS_SECTION_ORDER.map((sectionId) => {
          const section = SETTINGS_SECTIONS[sectionId];
          return (
            <a
              key={section.id}
              role="button"
              tabIndex={0}
              className={activeSettingsSection === section.id ? 'on' : ''}
              onClick={() => {
                if (activeSettingsSection !== section.id) {
                  requestSettingsAction({ kind: 'switch-section', nextSection: section.id });
                }
              }}
            >
              {section.title}
            </a>
          );
        })}
      </div>
      <div className="set-main">
        {settingsLoading && <p className="hint">Loading config…</p>}
        {settingsError && <p className="error">{settingsError}</p>}
        {dashboardConfig && (
          <>
            <div className="set-head">
              <h2>{activeSection.title}</h2>
              {settingsDirty ? <span className="dirty-pill">Unsaved changes</span> : null}
              {settingsSavedAtUtc ? <span className="hint">Saved {formatDate(settingsSavedAtUtc)}</span> : null}
              <span style={{ flex: 1 }} />
              <button
                type="button"
                className="ghost-btn"
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
                className="ghost-btn"
                onClick={() => {
                  if (settingsDirty) {
                    requestSettingsAction({ kind: 'restart-backend' });
                    return;
                  }
                  void restartDashboardBackendCore();
                }}
                disabled={settingsActionBusy || !settingsRestartSupported}
              >
                {settingsRestarting ? 'Restarting…' : 'Restart backend'}
              </button>
              <button type="button" className="save" onClick={() => { void onSaveDashboardSettings(); }} disabled={settingsActionBusy}>
                {settingsSaving ? 'Saving…' : 'Save settings'}
              </button>
            </div>
            <p className="sec-hint">{activeSection.summary}</p>
            <div className="set-sec on">{renderSettingsSection()}</div>
          </>
        )}
      </div>
    </>
  );
}

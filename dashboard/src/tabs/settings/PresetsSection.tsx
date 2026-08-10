import React from 'react';

import {
  getEffectivePresetTools,
  PRESET_TOOL_OPTIONS,
} from '../../preset-editor';
import { isPresetKind, isPresetOperationMode } from '../../../../src/presets.js';
import { SettingsField } from '../../settings/SettingsFields';
import type { PresetSettingsActions } from '../../settings-action-groups';
import {
  isPresetAutoloadPickerBusy,
  type SettingsPathPickerBusyTarget,
} from '../../settings-flow';
import type {
  DashboardConfig,
  DashboardPreset,
} from '../../types';

type PresetsSectionProps = {
  dashboardConfig: DashboardConfig | null;
  selectedSettingsPreset: DashboardPreset | null;
  selectedSettingsPresetId: string | null;
  settingsActionBusy: boolean;
  settingsPathPickerBusyTarget: SettingsPathPickerBusyTarget | null;
  presetActions: PresetSettingsActions;
};

export function PresetsSection({
  dashboardConfig,
  selectedSettingsPreset,
  selectedSettingsPresetId,
  settingsActionBusy,
  settingsPathPickerBusyTarget,
  presetActions,
}: PresetsSectionProps) {
  if (!dashboardConfig) {
    return null;
  }

  const preset = selectedSettingsPreset;
  const modeAllowedTools = preset ? dashboardConfig.OperationModeAllowedTools[preset.operationMode] : [];
  const effectiveTools = preset
    ? getEffectivePresetTools(preset, dashboardConfig.OperationModeAllowedTools)
    : [];

  return (
    <div className="plib">
      <div className="plist">
        {dashboardConfig.Presets.map((entry) => (
          <div
            key={entry.id}
            className={selectedSettingsPresetId === entry.id ? 'prow sel' : 'prow'}
            role="button"
            tabIndex={0}
            onClick={() => presetActions.selectPreset(entry.id)}
          >
            <span className="t">{entry.label}</span>
            <span className="badges">
              <span className="bdg">{entry.presetKind}</span>
              <span className="bdg">{entry.operationMode}</span>
              <span className={entry.deletable ? 'bdg custom' : 'bdg'}>{entry.deletable ? 'custom' : 'builtin'}</span>
            </span>
          </div>
        ))}
        <button type="button" className="plist-add" onClick={presetActions.addPreset}>+ Add preset</button>
      </div>

      {preset ? (
        <div className="pcard">
          <div className="pmeta">
            {preset.id} · {preset.deletable ? 'custom' : 'builtin'} · {preset.deletable ? 'deletable' : 'protected'}
            <button
              type="button"
              className="ghost-btn"
              onClick={() => presetActions.deletePreset(preset.id)}
              disabled={!preset.deletable}
              style={{ marginLeft: 10 }}
            >
              Delete
            </button>
          </div>
          <div className="fgrid">
            <SettingsField label="Name" layout="half">
              <input value={preset.label} onChange={(event) => presetActions.setString(preset.id, 'label', event.target.value)} />
            </SettingsField>
            <SettingsField label="Preset kind" layout="quarter">
              <select
                value={preset.presetKind}
                onChange={(event) => {
                  if (isPresetKind(event.target.value)) {
                    presetActions.setKind(preset.id, event.target.value);
                  }
                }}
                disabled={preset.builtin}
              >
                <option value="summary">summary</option>
                <option value="chat">chat</option>
                <option value="plan">plan</option>
                <option value="repo-search">repo-search</option>
              </select>
            </SettingsField>
            <SettingsField label="Operation mode" layout="quarter">
              <select
                value={preset.operationMode}
                onChange={(event) => {
                  if (isPresetOperationMode(event.target.value)) {
                    presetActions.setOperationMode(preset.id, event.target.value);
                  }
                }}
              >
                <option value="summary">summary</option>
                <option value="read-only">read-only</option>
                <option value="full">full</option>
              </select>
            </SettingsField>
            <SettingsField label={`Tool whitelist · ${effectiveTools.length} enabled of ${modeAllowedTools.length} allowed by ${preset.operationMode} mode`} layout="full">
              <div className="tool-chips">
                {PRESET_TOOL_OPTIONS.map((tool) => {
                  const blocked = !modeAllowedTools.includes(tool);
                  const enabled = preset.allowedTools.includes(tool) && !blocked;
                  const className = `tchip${blocked ? ' blocked' : enabled ? ' on' : ''}`;
                  return (
                    <button
                      key={tool}
                      type="button"
                      className={className}
                      disabled={blocked}
                      onClick={() => presetActions.setToolEnabled(preset.id, tool, !enabled)}
                    >
                      {tool}
                    </button>
                  );
                })}
              </div>
              <span className="fhint">Struck-out tools are blocked by the {preset.operationMode} mode policy regardless of this whitelist.</span>
            </SettingsField>
            <SettingsField label="Description" layout="full">
              <input value={preset.description} onChange={(event) => presetActions.setString(preset.id, 'description', event.target.value)} />
            </SettingsField>
            <SettingsField label="Prompt override" layout="full">
              <textarea rows={3} value={preset.promptPrefix} onChange={(event) => presetActions.setString(preset.id, 'promptPrefix', event.target.value)} />
            </SettingsField>
            <SettingsField label="CLI surface" layout="quarter">
              <input
                type="checkbox"
                checked={preset.surfaces.includes('cli')}
                onChange={(event) => presetActions.setSurfaceEnabled(preset.id, 'cli', event.target.checked)}
              />
            </SettingsField>
            <SettingsField label="Web surface" layout="quarter">
              <input
                type="checkbox"
                checked={preset.surfaces.includes('web')}
                onChange={(event) => presetActions.setSurfaceEnabled(preset.id, 'web', event.target.checked)}
              />
            </SettingsField>
            <SettingsField label="Load AGENTS.md" layout="quarter">
              <input
                type="checkbox"
                checked={preset.includeAgentsMd}
                onChange={(event) => presetActions.setAgentsMdEnabled(preset.id, event.target.checked)}
              />
            </SettingsField>
            <SettingsField label="Load repository file list" layout="quarter">
              <input
                type="checkbox"
                checked={preset.includeRepoFileListing}
                onChange={(event) => presetActions.setRepoFileListingEnabled(preset.id, event.target.checked)}
              />
            </SettingsField>
            <SettingsField label="Assistant memory" layout="quarter">
              <input
                type="checkbox"
                checked={preset.assistantMemory}
                onChange={(event) => presetActions.setAssistantMemoryEnabled(preset.id, event.target.checked)}
              />
            </SettingsField>
            <SettingsField label="Autoload files" layout="full">
              <div className="preset-autoload-files">
                {preset.autoloadFiles.map((file, index) => (
                  <div className="preset-autoload-file" key={`${preset.id}:${index}`}>
                    <input
                      aria-label={`Autoload file ${index + 1}`}
                      value={file}
                      onChange={(event) => presetActions.setAutoloadFile(preset.id, index, event.target.value)}
                    />
                    <button
                      type="button"
                      className="ghost-btn"
                      onClick={() => { void presetActions.pickAutoloadFile(preset.id, index); }}
                      disabled={settingsActionBusy}
                    >
                      {isPresetAutoloadPickerBusy(settingsPathPickerBusyTarget, preset.id, index) ? 'Opening…' : 'Browse…'}
                    </button>
                    <button
                      type="button"
                      className="ghost-btn"
                      onClick={() => presetActions.removeAutoloadFile(preset.id, index)}
                    >
                      Remove
                    </button>
                  </div>
                ))}
                <button
                  type="button"
                  className="ghost-btn"
                  onClick={() => presetActions.addAutoloadFile(preset.id)}
                >
                  + Add file
                </button>
              </div>
            </SettingsField>
            <SettingsField label="Use for default summary" layout="quarter">
              <input
                type="checkbox"
                checked={preset.useForSummary}
                onChange={(event) => {
                  if (event.target.checked) presetActions.setSummaryDefault(preset.id);
                }}
                disabled={preset.presetKind !== 'summary'}
              />
            </SettingsField>
          </div>
        </div>
      ) : null}
    </div>
  );
}

import React from 'react';

import {
  getEffectivePresetTools,
  PRESET_TOOL_OPTIONS,
} from '../../preset-editor';
import { isPresetKind, isPresetOperationMode } from '../../../../src/presets.js';
import { SettingsField } from '../../settings/SettingsFields';
import type {
  DashboardConfig,
  DashboardPreset,
  DashboardPresetKind,
  DashboardPresetOperationMode,
  DashboardPresetSurface,
  DashboardPresetToolName,
} from '../../types';

type PresetsSectionProps = {
  dashboardConfig: DashboardConfig | null;
  selectedSettingsPreset: DashboardPreset | null;
  selectedSettingsPresetId: string | null;
  setSelectedSettingsPresetId(presetId: string): void;
  setPresetLabel(presetId: string, label: string): void;
  setPresetKind(presetId: string, kind: DashboardPresetKind): void;
  setPresetOperationMode(presetId: string, operationMode: DashboardPresetOperationMode): void;
  togglePresetTool(presetId: string, tool: DashboardPresetToolName): void;
  setPresetDescription(presetId: string, description: string): void;
  setPresetPromptPrefix(presetId: string, promptPrefix: string): void;
  setPresetSurfaceEnabled(presetId: string, surface: DashboardPresetSurface, enabled: boolean): void;
  setPresetAgentsMdEnabled(presetId: string, enabled: boolean): void;
  setPresetRepoFileListingEnabled(presetId: string, enabled: boolean): void;
  setPresetAutoloadFile(presetId: string, index: number, path: string): void;
  addPresetAutoloadFile(presetId: string): void;
  removePresetAutoloadFile(presetId: string, index: number): void;
  setDefaultSummaryPreset(presetId: string, enabled: boolean): void;
  onAddPreset(): void;
  onDeletePreset(presetId: string): void;
};

export function PresetsSection({
  dashboardConfig,
  selectedSettingsPreset,
  selectedSettingsPresetId,
  setSelectedSettingsPresetId,
  setPresetLabel,
  setPresetKind,
  setPresetOperationMode,
  togglePresetTool,
  setPresetDescription,
  setPresetPromptPrefix,
  setPresetSurfaceEnabled,
  setPresetAgentsMdEnabled,
  setPresetRepoFileListingEnabled,
  setPresetAutoloadFile,
  addPresetAutoloadFile,
  removePresetAutoloadFile,
  setDefaultSummaryPreset,
  onAddPreset,
  onDeletePreset,
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
            onClick={() => setSelectedSettingsPresetId(entry.id)}
          >
            <span className="t">{entry.label}</span>
            <span className="badges">
              <span className="bdg">{entry.presetKind}</span>
              <span className="bdg">{entry.operationMode}</span>
              <span className={entry.deletable ? 'bdg custom' : 'bdg'}>{entry.deletable ? 'custom' : 'builtin'}</span>
            </span>
          </div>
        ))}
        <button type="button" className="plist-add" onClick={onAddPreset}>+ Add preset</button>
      </div>

      {preset ? (
        <div className="pcard">
          <div className="pmeta">
            {preset.id} · {preset.deletable ? 'custom' : 'builtin'} · {preset.deletable ? 'deletable' : 'protected'}
            <button
              type="button"
              className="ghost-btn"
              onClick={() => onDeletePreset(preset.id)}
              disabled={!preset.deletable}
              style={{ marginLeft: 10 }}
            >
              Delete
            </button>
          </div>
          <div className="fgrid">
            <SettingsField label="Name" layout="half">
              <input value={preset.label} onChange={(event) => setPresetLabel(preset.id, event.target.value)} />
            </SettingsField>
            <SettingsField label="Preset kind" layout="quarter">
              <select
                value={preset.presetKind}
                onChange={(event) => {
                  if (isPresetKind(event.target.value)) {
                    setPresetKind(preset.id, event.target.value);
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
                    setPresetOperationMode(preset.id, event.target.value);
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
                      onClick={() => togglePresetTool(preset.id, tool)}
                    >
                      {tool}
                    </button>
                  );
                })}
              </div>
              <span className="fhint">Struck-out tools are blocked by the {preset.operationMode} mode policy regardless of this whitelist.</span>
            </SettingsField>
            <SettingsField label="Description" layout="full">
              <input value={preset.description} onChange={(event) => setPresetDescription(preset.id, event.target.value)} />
            </SettingsField>
            <SettingsField label="Prompt override" layout="full">
              <textarea rows={3} value={preset.promptPrefix} onChange={(event) => setPresetPromptPrefix(preset.id, event.target.value)} />
            </SettingsField>
            <SettingsField label="CLI surface" layout="quarter">
              <input
                type="checkbox"
                checked={preset.surfaces.includes('cli')}
                onChange={(event) => setPresetSurfaceEnabled(preset.id, 'cli', event.target.checked)}
              />
            </SettingsField>
            <SettingsField label="Web surface" layout="quarter">
              <input
                type="checkbox"
                checked={preset.surfaces.includes('web')}
                onChange={(event) => setPresetSurfaceEnabled(preset.id, 'web', event.target.checked)}
              />
            </SettingsField>
            <SettingsField label="Load AGENTS.md" layout="quarter">
              <input
                type="checkbox"
                checked={preset.includeAgentsMd}
                onChange={(event) => setPresetAgentsMdEnabled(preset.id, event.target.checked)}
              />
            </SettingsField>
            <SettingsField label="Load repository file list" layout="quarter">
              <input
                type="checkbox"
                checked={preset.includeRepoFileListing}
                onChange={(event) => setPresetRepoFileListingEnabled(preset.id, event.target.checked)}
              />
            </SettingsField>
            <SettingsField label="Autoload files" layout="full">
              <div className="preset-autoload-files">
                {preset.autoloadFiles.map((file, index) => (
                  <div className="preset-autoload-file" key={`${preset.id}:${index}`}>
                    <input
                      aria-label={`Autoload file ${index + 1}`}
                      value={file}
                      onChange={(event) => setPresetAutoloadFile(preset.id, index, event.target.value)}
                    />
                    <button
                      type="button"
                      className="ghost-btn"
                      onClick={() => removePresetAutoloadFile(preset.id, index)}
                    >
                      Remove
                    </button>
                  </div>
                ))}
                <button
                  type="button"
                  className="ghost-btn"
                  onClick={() => addPresetAutoloadFile(preset.id)}
                >
                  + Add file
                </button>
              </div>
            </SettingsField>
            <SettingsField label="Use for default summary" layout="quarter">
              <input
                type="checkbox"
                checked={preset.useForSummary}
                onChange={(event) => setDefaultSummaryPreset(preset.id, event.target.checked)}
                disabled={preset.presetKind !== 'summary'}
              />
            </SettingsField>
          </div>
        </div>
      ) : null}
    </div>
  );
}

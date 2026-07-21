import React from 'react';

import {
  applyOperationModeDefaults,
  applyPresetKindDefaults,
  getEffectivePresetTools,
  PRESET_TOOL_OPTIONS,
  togglePresetTool,
} from '../../preset-editor';
import { isPresetKind, isPresetOperationMode } from '../../../../src/presets.js';
import { SettingsField } from '../../settings/SettingsFields';
import type { DashboardConfig, DashboardPreset } from '../../types';

type PresetsSectionProps = {
  dashboardConfig: DashboardConfig | null;
  selectedSettingsPreset: DashboardPreset | null;
  selectedSettingsPresetId: string | null;
  setSelectedSettingsPresetId(presetId: string): void;
  updateSettingsDraft(updater: (next: DashboardConfig) => void): void;
  updatePresetDraft(presetId: string, updater: (preset: DashboardPreset) => void): void;
  onAddPreset(): void;
  onDeletePreset(presetId: string): void;
};

export function PresetsSection({
  dashboardConfig,
  selectedSettingsPreset,
  selectedSettingsPresetId,
  setSelectedSettingsPresetId,
  updateSettingsDraft,
  updatePresetDraft,
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
              <input value={preset.label} onChange={(event) => updatePresetDraft(preset.id, (next) => { next.label = event.target.value; })} />
            </SettingsField>
            <SettingsField label="Preset kind" layout="quarter">
              <select
                value={preset.presetKind}
                onChange={(event) => updatePresetDraft(preset.id, (next) => {
                  if (isPresetKind(event.target.value)) {
                    applyPresetKindDefaults(next, event.target.value);
                  }
                })}
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
                onChange={(event) => updatePresetDraft(preset.id, (next) => {
                  if (isPresetOperationMode(event.target.value)) {
                    applyOperationModeDefaults(next, event.target.value);
                  }
                })}
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
                      onClick={() => updatePresetDraft(preset.id, (next) => { next.allowedTools = togglePresetTool(next.allowedTools, tool); })}
                    >
                      {tool}
                    </button>
                  );
                })}
              </div>
              <span className="fhint">Struck-out tools are blocked by the {preset.operationMode} mode policy regardless of this whitelist.</span>
            </SettingsField>
            <SettingsField label="Description" layout="full">
              <input value={preset.description} onChange={(event) => updatePresetDraft(preset.id, (next) => { next.description = event.target.value; })} />
            </SettingsField>
            <SettingsField label="Prompt override" layout="full">
              <textarea rows={3} value={preset.promptPrefix} onChange={(event) => updatePresetDraft(preset.id, (next) => { next.promptPrefix = event.target.value; })} />
            </SettingsField>
            <SettingsField label="CLI surface" layout="quarter">
              <input
                type="checkbox"
                checked={preset.surfaces.includes('cli')}
                onChange={(event) => updatePresetDraft(preset.id, (next) => {
                  next.surfaces = event.target.checked
                    ? Array.from(new Set([...next.surfaces, 'cli']))
                    : next.surfaces.filter((surface) => surface !== 'cli');
                })}
              />
            </SettingsField>
            <SettingsField label="Web surface" layout="quarter">
              <input
                type="checkbox"
                checked={preset.surfaces.includes('web')}
                onChange={(event) => updatePresetDraft(preset.id, (next) => {
                  next.surfaces = event.target.checked
                    ? Array.from(new Set([...next.surfaces, 'web']))
                    : next.surfaces.filter((surface) => surface !== 'web');
                })}
              />
            </SettingsField>
            {preset.operationMode === 'read-only' ? (
              <>
                <SettingsField label="Include AGENTS.md" layout="quarter">
                  <input
                    type="checkbox"
                    checked={preset.includeAgentsMd}
                    onChange={(event) => updatePresetDraft(preset.id, (next) => { next.includeAgentsMd = event.target.checked; })}
                  />
                </SettingsField>
                <SettingsField label="Include repo file list" layout="quarter">
                  <input
                    type="checkbox"
                    checked={preset.includeRepoFileListing}
                    onChange={(event) => updatePresetDraft(preset.id, (next) => { next.includeRepoFileListing = event.target.checked; })}
                  />
                </SettingsField>
              </>
            ) : null}
            <SettingsField label="Use for default summary" layout="quarter">
              <input
                type="checkbox"
                checked={preset.useForSummary}
                onChange={(event) => updateSettingsDraft((next) => {
                  next.Presets.forEach((entry) => {
                    entry.useForSummary = entry.id === preset.id ? event.target.checked : false;
                  });
                })}
                disabled={preset.presetKind !== 'summary'}
              />
            </SettingsField>
          </div>
        </div>
      ) : null}
    </div>
  );
}

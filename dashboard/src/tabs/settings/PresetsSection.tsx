import React from 'react';
import type { ReactNode } from 'react';

import {
  applyOperationModeDefaults,
  applyPresetKindDefaults,
  getEffectivePresetTools,
  getPresetToolsSummary,
  PRESET_TOOL_DESCRIPTIONS,
  PRESET_TOOL_OPTIONS,
  togglePresetTool,
} from '../../preset-editor';
import { SettingsInlineHelpLabel } from '../../settings/SettingsFields';
import type { SettingsSectionId } from '../../settings-sections';
import type { DashboardConfig, DashboardPreset } from '../../types';

type RenderField = (
  sectionId: SettingsSectionId,
  label: string,
  children: ReactNode,
  className?: string,
) => ReactNode;

type PresetsSectionProps = {
  dashboardConfig: DashboardConfig | null;
  selectedSettingsPreset: DashboardPreset | null;
  selectedSettingsPresetId: string | null;
  renderField: RenderField;
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
  renderField,
  setSelectedSettingsPresetId,
  updateSettingsDraft,
  updatePresetDraft,
  onAddPreset,
  onDeletePreset,
}: PresetsSectionProps) {
  if (!dashboardConfig) {
    return null;
  }

  return (
    <div className="settings-live-grid">
      {renderField('presets', 'Preset library', (
        <div className="settings-preset-library">
          <div className="settings-preset-toolbar">
            <label className="settings-preset-selector">
              <span className="settings-preset-inline-label"><SettingsInlineHelpLabel label="Preset" helpText="Pick which preset to edit." /></span>
              <select
                value={selectedSettingsPresetId ?? ''}
                onChange={(event) => setSelectedSettingsPresetId(event.target.value)}
                disabled={dashboardConfig.Presets.length === 0}
              >
                {dashboardConfig.Presets.length === 0 ? <option value="">No presets</option> : null}
                {dashboardConfig.Presets.map((preset) => (
                  <option key={preset.id} value={preset.id}>{preset.label}</option>
                ))}
              </select>
            </label>
            <div className="settings-preset-library-actions">
              <button type="button" onClick={onAddPreset}>Add Preset</button>
              <button
                type="button"
                onClick={() => {
                  if (selectedSettingsPreset) {
                    onDeletePreset(selectedSettingsPreset.id);
                  }
                }}
                disabled={!selectedSettingsPreset?.deletable}
              >
                Delete
              </button>
            </div>
          </div>
          {selectedSettingsPreset ? (
            <article className="settings-preset-card">
              <header className="settings-preset-card-header">
                <div>
                  <strong>{selectedSettingsPreset.label}</strong>
                  <span className="hint">{selectedSettingsPreset.id} | {selectedSettingsPreset.presetKind} | {selectedSettingsPreset.operationMode} | {selectedSettingsPreset.deletable ? 'custom' : 'builtin'}</span>
                </div>
              </header>
              <div className="settings-preset-card-grid">
                <label>
                  <span className="settings-preset-inline-label"><SettingsInlineHelpLabel label="Name" helpText="User-facing preset label shown in pickers." /></span>
                  <input
                    value={selectedSettingsPreset.label}
                    onChange={(event) => updatePresetDraft(selectedSettingsPreset.id, (next) => { next.label = event.target.value; })}
                  />
                </label>
                <label>
                  <span className="settings-preset-inline-label"><SettingsInlineHelpLabel label="Preset kind" helpText="Routing and output behavior for this preset: summary, chat, plan, or repo-search." /></span>
                  <select
                    value={selectedSettingsPreset.presetKind}
                    onChange={(event) => updatePresetDraft(selectedSettingsPreset.id, (next) => {
                      applyPresetKindDefaults(next, event.target.value as DashboardPreset['presetKind']);
                    })}
                    disabled={selectedSettingsPreset.builtin}
                  >
                    <option value="summary">summary</option>
                    <option value="chat">chat</option>
                    <option value="plan">plan</option>
                    <option value="repo-search">repo-search</option>
                  </select>
                </label>
                <label>
                  <span className="settings-preset-inline-label"><SettingsInlineHelpLabel label="Operation mode" helpText="Capability policy for this preset: direct summary fallback tools, read-only repo tools, or future full tools." /></span>
                  <select
                    value={selectedSettingsPreset.operationMode}
                    onChange={(event) => updatePresetDraft(selectedSettingsPreset.id, (next) => {
                      applyOperationModeDefaults(next, event.target.value as DashboardPreset['operationMode']);
                    })}
                  >
                    <option value="summary">summary</option>
                    <option value="read-only">read-only</option>
                    <option value="full">full</option>
                  </select>
                </label>
                <label>
                  <span className="settings-preset-inline-label"><SettingsInlineHelpLabel label="CLI surface" helpText="Whether this preset appears in CLI discovery and can run from `siftkit run --preset`." /></span>
                  <input
                    type="checkbox"
                    checked={selectedSettingsPreset.surfaces.includes('cli')}
                    onChange={(event) => updatePresetDraft(selectedSettingsPreset.id, (next) => {
                      next.surfaces = event.target.checked
                        ? Array.from(new Set([...next.surfaces, 'cli']))
                        : next.surfaces.filter((surface) => surface !== 'cli');
                    })}
                  />
                </label>
                <label>
                  <span className="settings-preset-inline-label"><SettingsInlineHelpLabel label="Web surface" helpText="Whether this preset appears in the dashboard chat preset picker." /></span>
                  <input
                    type="checkbox"
                    checked={selectedSettingsPreset.surfaces.includes('web')}
                    onChange={(event) => updatePresetDraft(selectedSettingsPreset.id, (next) => {
                      next.surfaces = event.target.checked
                        ? Array.from(new Set([...next.surfaces, 'web']))
                        : next.surfaces.filter((surface) => surface !== 'web');
                    })}
                  />
                </label>
                <label className="settings-preset-card-wide">
                  <span className="settings-preset-inline-label"><SettingsInlineHelpLabel label="Description" helpText="Short operator-facing explanation of when to use this preset." /></span>
                  <input
                    value={selectedSettingsPreset.description}
                    onChange={(event) => updatePresetDraft(selectedSettingsPreset.id, (next) => { next.description = event.target.value; })}
                  />
                </label>
                <label className="settings-preset-card-wide">
                  <span className="settings-preset-inline-label"><SettingsInlineHelpLabel label="Prompt override" helpText="Preset-specific instruction prefix layered onto the family behavior. Leave empty to fall back to the global prompt prefix or family default." /></span>
                  <textarea
                    rows={3}
                    value={selectedSettingsPreset.promptPrefix}
                    onChange={(event) => updatePresetDraft(selectedSettingsPreset.id, (next) => { next.promptPrefix = event.target.value; })}
                  />
                </label>
                <label className="settings-preset-card-wide">
                  <span className="settings-preset-inline-label"><SettingsInlineHelpLabel label="Allowed tools" helpText="Tools permitted for this preset. Toggle each option directly." /></span>
                  <div className="settings-preset-tools-list">
                    {PRESET_TOOL_OPTIONS.map((tool) => (
                      <label key={tool} className="settings-preset-tools-option" tabIndex={0}>
                        <input
                          type="checkbox"
                          checked={selectedSettingsPreset.allowedTools.includes(tool)}
                          onChange={() => updatePresetDraft(selectedSettingsPreset.id, (next) => {
                            next.allowedTools = togglePresetTool(next.allowedTools, tool);
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
                </label>
                <label className="settings-preset-card-wide">
                  <span className="settings-preset-inline-label"><SettingsInlineHelpLabel label="Effective tools" helpText="Intersection of the preset whitelist and the global operation-mode policy." /></span>
                  <input
                    readOnly
                    value={getPresetToolsSummary(getEffectivePresetTools(
                      selectedSettingsPreset,
                      dashboardConfig.OperationModeAllowedTools,
                    )) || 'No tools enabled'}
                  />
                </label>
                {selectedSettingsPreset.operationMode === 'read-only' ? (
                  <>
                    <label>
                      <span className="settings-preset-inline-label"><SettingsInlineHelpLabel label="Include AGENTS.md" helpText="Adds the repository root `agents.md` or `AGENTS.md` instructions block to the read-only tool-call system prompt." /></span>
                      <input
                        type="checkbox"
                        checked={selectedSettingsPreset.includeAgentsMd}
                        onChange={(event) => updatePresetDraft(selectedSettingsPreset.id, (next) => { next.includeAgentsMd = event.target.checked; })}
                      />
                    </label>
                    <label>
                      <span className="settings-preset-inline-label"><SettingsInlineHelpLabel label="Include repo file list" helpText="Adds the startup repository file listing to the read-only tool-call user prompt before tool calls begin." /></span>
                      <input
                        type="checkbox"
                        checked={selectedSettingsPreset.includeRepoFileListing}
                        onChange={(event) => updatePresetDraft(selectedSettingsPreset.id, (next) => { next.includeRepoFileListing = event.target.checked; })}
                      />
                    </label>
                  </>
                ) : null}
                <label>
                  <span className="settings-preset-inline-label"><SettingsInlineHelpLabel label="Use for default summary" helpText="Marks the summary preset used by default CLI summarization flows." /></span>
                  <input
                    type="checkbox"
                    checked={selectedSettingsPreset.useForSummary}
                    onChange={(event) => updateSettingsDraft((next) => {
                      next.Presets.forEach((entry) => {
                        entry.useForSummary = entry.id === selectedSettingsPreset.id ? event.target.checked : false;
                      });
                    })}
                    disabled={selectedSettingsPreset.presetKind !== 'summary'}
                  />
                </label>
              </div>
            </article>
          ) : null}
        </div>
      ))}
    </div>
  );
}

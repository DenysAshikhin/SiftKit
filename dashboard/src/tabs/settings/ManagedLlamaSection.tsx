import React from 'react';
import type { ReactNode } from 'react';

import { applyManagedLlamaPresetSelection } from '../../managed-llama-presets';
import { parseFloatInput, parseIntegerInput } from '../../lib/format';
import { SettingsInlineHelpLabel } from '../../settings/SettingsFields';
import type { SettingsSectionId } from '../../settings-sections';
import type { DashboardConfig, DashboardManagedLlamaPreset } from '../../types';

const KV_CACHE_QUANT_OPTIONS = ['f32', 'f16', 'bf16', 'q8_0', 'q4_0', 'q4_1', 'iq4_nl', 'q5_0', 'q5_1'] as const;
const SPECULATIVE_TYPE_OPTIONS = ['ngram-simple', 'ngram-map-k', 'ngram-map-k4v', 'ngram-mod', 'ngram-cache'] as const;

type RenderField = (
  sectionId: SettingsSectionId,
  label: string,
  children: ReactNode,
  className?: string,
) => ReactNode;

type ManagedLlamaSectionProps = {
  dashboardConfig: DashboardConfig | null;
  selectedManagedLlamaPreset: DashboardManagedLlamaPreset | null;
  settingsActionBusy: boolean;
  settingsPathPickerBusyTarget: 'ExecutablePath' | 'ModelPath' | null;
  renderField: RenderField;
  updateSettingsDraft(updater: (next: DashboardConfig) => void): void;
  updateManagedLlamaDraft(updater: (preset: DashboardManagedLlamaPreset) => void): void;
  onAddManagedLlamaPreset(): void;
  onDeleteManagedLlamaPreset(presetId: string): void;
  onPickManagedLlamaPath(target: 'ExecutablePath' | 'ModelPath'): Promise<void>;
};

export function ManagedLlamaSection({
  dashboardConfig,
  selectedManagedLlamaPreset,
  settingsActionBusy,
  settingsPathPickerBusyTarget,
  renderField,
  updateSettingsDraft,
  updateManagedLlamaDraft,
  onAddManagedLlamaPreset,
  onDeleteManagedLlamaPreset,
  onPickManagedLlamaPath,
}: ManagedLlamaSectionProps) {
  if (!dashboardConfig || !selectedManagedLlamaPreset) {
    return null;
  }
  const reasoningEnabled = selectedManagedLlamaPreset.Reasoning === 'on';
  const reasoningContentEnabled = reasoningEnabled && selectedManagedLlamaPreset.ReasoningContent;

  return (
    <div className="settings-live-grid">
      <div className="managed-llama-top-row">
        {renderField('model-presets', 'Model preset', (
          <div className="settings-preset-library">
            <div className="settings-preset-toolbar">
              <label className="settings-preset-selector">
                <span className="settings-preset-inline-label"><SettingsInlineHelpLabel label="Preset" helpText="Pick which managed llama launcher preset to edit and launch." /></span>
                <select
                  value={dashboardConfig.Server.LlamaCpp.ActivePresetId}
                  onChange={(event) => updateSettingsDraft((next) => {
                    applyManagedLlamaPresetSelection(next, event.target.value);
                  })}
                  disabled={dashboardConfig.Server.LlamaCpp.Presets.length === 0}
                >
                  {dashboardConfig.Server.LlamaCpp.Presets.map((preset) => (
                    <option key={preset.id} value={preset.id}>{preset.label}</option>
                  ))}
                </select>
              </label>
              <div className="settings-preset-library-actions">
                <button type="button" onClick={onAddManagedLlamaPreset}>Add Preset</button>
                <button
                  type="button"
                  onClick={() => { onDeleteManagedLlamaPreset(selectedManagedLlamaPreset.id); }}
                  disabled={dashboardConfig.Server.LlamaCpp.Presets.length <= 1}
                >
                  Delete
                </button>
              </div>
            </div>
          </div>
        ), 'managed-llama-top-field')}
        {renderField('model-presets', 'Preset name', (
          <input
            value={selectedManagedLlamaPreset.label}
            onChange={(event) => updateManagedLlamaDraft((preset) => { preset.label = event.target.value; })}
          />
        ), 'managed-llama-top-field')}
        {renderField('model-presets', 'Executable path', (
          <div className="settings-live-nav-control">
            <input
              value={selectedManagedLlamaPreset.ExecutablePath || ''}
              onChange={(event) => updateManagedLlamaDraft((preset) => {
                const value = event.target.value.trim();
                preset.ExecutablePath = value || null;
              })}
            />
            <button type="button" onClick={() => { void onPickManagedLlamaPath('ExecutablePath'); }} disabled={settingsActionBusy}>
              {settingsPathPickerBusyTarget === 'ExecutablePath' ? 'Opening...' : 'Browse...'}
            </button>
          </div>
        ), 'managed-llama-top-field')}
      </div>
      {renderField('model-presets', 'Base URL', (
        <input value={selectedManagedLlamaPreset.BaseUrl} onChange={(event) => updateManagedLlamaDraft((preset) => { preset.BaseUrl = event.target.value; })} />
      ))}
      {renderField('model-presets', 'Bind host', (
        <input value={selectedManagedLlamaPreset.BindHost} onChange={(event) => updateManagedLlamaDraft((preset) => { preset.BindHost = event.target.value; })} />
      ))}
      {renderField('model-presets', 'Port', (
        <input type="number" value={selectedManagedLlamaPreset.Port} onChange={(event) => updateManagedLlamaDraft((preset) => { preset.Port = parseIntegerInput(event.target.value, preset.Port); })} />
      ))}
      {renderField('model-presets', 'Model path (.gguf)', (
        <div className="settings-live-nav-control">
          <input
            value={selectedManagedLlamaPreset.ModelPath || ''}
            onChange={(event) => updateManagedLlamaDraft((preset) => {
              const value = event.target.value.trim();
              preset.ModelPath = value || null;
            })}
          />
          <button type="button" onClick={() => { void onPickManagedLlamaPath('ModelPath'); }} disabled={settingsActionBusy}>
            {settingsPathPickerBusyTarget === 'ModelPath' ? 'Opening...' : 'Browse...'}
          </button>
        </div>
      ))}
      {renderField('model-presets', 'NumCtx', (
        <input type="number" value={selectedManagedLlamaPreset.NumCtx} onChange={(event) => updateManagedLlamaDraft((preset) => { preset.NumCtx = parseIntegerInput(event.target.value, preset.NumCtx); })} />
      ))}
      {renderField('model-presets', 'GpuLayers', (
        <input type="number" value={selectedManagedLlamaPreset.GpuLayers} onChange={(event) => updateManagedLlamaDraft((preset) => { preset.GpuLayers = parseIntegerInput(event.target.value, preset.GpuLayers); })} />
      ))}
      {renderField('model-presets', 'Threads', (
        <input type="number" value={selectedManagedLlamaPreset.Threads} onChange={(event) => updateManagedLlamaDraft((preset) => { preset.Threads = parseIntegerInput(event.target.value, preset.Threads); })} />
      ))}
      {renderField('model-presets', 'NcpuMoe', (
        <input type="number" value={selectedManagedLlamaPreset.NcpuMoe} onChange={(event) => updateManagedLlamaDraft((preset) => { preset.NcpuMoe = parseIntegerInput(event.target.value, preset.NcpuMoe); })} />
      ))}
      {renderField('model-presets', 'Flash attention', (
        <label className="settings-live-toggle-control">
          <input type="checkbox" checked={selectedManagedLlamaPreset.FlashAttention} onChange={(event) => updateManagedLlamaDraft((preset) => { preset.FlashAttention = event.target.checked; })} />
          <span>{selectedManagedLlamaPreset.FlashAttention ? 'Enabled' : 'Disabled'}</span>
        </label>
      ))}
      {renderField('model-presets', 'ParallelSlots', (
        <input type="number" value={selectedManagedLlamaPreset.ParallelSlots} onChange={(event) => updateManagedLlamaDraft((preset) => { preset.ParallelSlots = parseIntegerInput(event.target.value, preset.ParallelSlots); })} />
      ))}
      {renderField('model-presets', 'BatchSize', (
        <input type="number" value={selectedManagedLlamaPreset.BatchSize} onChange={(event) => updateManagedLlamaDraft((preset) => { preset.BatchSize = parseIntegerInput(event.target.value, preset.BatchSize); })} />
      ))}
      {renderField('model-presets', 'UBatchSize', (
        <input type="number" value={selectedManagedLlamaPreset.UBatchSize} onChange={(event) => updateManagedLlamaDraft((preset) => { preset.UBatchSize = parseIntegerInput(event.target.value, preset.UBatchSize); })} />
      ))}
      {renderField('model-presets', 'CacheRam', (
        <input type="number" value={selectedManagedLlamaPreset.CacheRam} onChange={(event) => updateManagedLlamaDraft((preset) => { preset.CacheRam = parseIntegerInput(event.target.value, preset.CacheRam); })} />
      ))}
      {renderField('model-presets', 'KV cache quant', (
        <select value={selectedManagedLlamaPreset.KvCacheQuantization} onChange={(event) => updateManagedLlamaDraft((preset) => { preset.KvCacheQuantization = event.target.value as typeof preset.KvCacheQuantization; })}>
          {KV_CACHE_QUANT_OPTIONS.map((option) => (
            <option key={option} value={option}>{option}</option>
          ))}
        </select>
      ))}
      {renderField('model-presets', 'MaxTokens', (
        <input type="number" value={selectedManagedLlamaPreset.MaxTokens} onChange={(event) => updateManagedLlamaDraft((preset) => { preset.MaxTokens = parseIntegerInput(event.target.value, preset.MaxTokens); })} />
      ))}
      {renderField('model-presets', 'Temperature', (
        <input type="number" step="0.01" value={selectedManagedLlamaPreset.Temperature} onChange={(event) => updateManagedLlamaDraft((preset) => { preset.Temperature = parseFloatInput(event.target.value, preset.Temperature); })} />
      ))}
      {renderField('model-presets', 'TopP', (
        <input type="number" step="0.01" value={selectedManagedLlamaPreset.TopP} onChange={(event) => updateManagedLlamaDraft((preset) => { preset.TopP = parseFloatInput(event.target.value, preset.TopP); })} />
      ))}
      {renderField('model-presets', 'TopK', (
        <input type="number" value={selectedManagedLlamaPreset.TopK} onChange={(event) => updateManagedLlamaDraft((preset) => { preset.TopK = parseIntegerInput(event.target.value, preset.TopK); })} />
      ))}
      {renderField('model-presets', 'MinP', (
        <input type="number" step="0.01" value={selectedManagedLlamaPreset.MinP} onChange={(event) => updateManagedLlamaDraft((preset) => { preset.MinP = parseFloatInput(event.target.value, preset.MinP); })} />
      ))}
      {renderField('model-presets', 'PresencePenalty', (
        <input type="number" step="0.01" value={selectedManagedLlamaPreset.PresencePenalty} onChange={(event) => updateManagedLlamaDraft((preset) => { preset.PresencePenalty = parseFloatInput(event.target.value, preset.PresencePenalty); })} />
      ))}
      {renderField('model-presets', 'RepetitionPenalty', (
        <input type="number" step="0.01" value={selectedManagedLlamaPreset.RepetitionPenalty} onChange={(event) => updateManagedLlamaDraft((preset) => { preset.RepetitionPenalty = parseFloatInput(event.target.value, preset.RepetitionPenalty); })} />
      ))}
      {renderField('model-presets', 'Reasoning', (
        <select
          value={selectedManagedLlamaPreset.Reasoning}
          onChange={(event) => updateManagedLlamaDraft((preset) => {
            preset.Reasoning = event.target.value as 'on' | 'off';
            if (preset.Reasoning !== 'on') {
              preset.ReasoningContent = false;
              preset.PreserveThinking = false;
            }
          })}
        >
          <option value="off">off</option>
          <option value="on">on</option>
        </select>
      ))}
      {reasoningEnabled ? renderField('model-presets', 'Reasoning content', (
        <label className="settings-live-toggle-control">
          <input
            type="checkbox"
            checked={selectedManagedLlamaPreset.ReasoningContent}
            onChange={(event) => updateManagedLlamaDraft((preset) => {
              preset.ReasoningContent = event.target.checked;
              if (!preset.ReasoningContent) {
                preset.PreserveThinking = false;
              }
            })}
          />
          <span>{selectedManagedLlamaPreset.ReasoningContent ? 'Enabled' : 'Disabled'}</span>
        </label>
      )) : null}
      {reasoningContentEnabled ? renderField('model-presets', 'Preserve thinking', (
        <label className="settings-live-toggle-control">
          <input
            type="checkbox"
            checked={selectedManagedLlamaPreset.PreserveThinking}
            onChange={(event) => updateManagedLlamaDraft((preset) => { preset.PreserveThinking = event.target.checked; })}
          />
          <span>{selectedManagedLlamaPreset.PreserveThinking ? 'Enabled' : 'Disabled'}</span>
        </label>
      )) : null}
      {renderField('model-presets', 'Enable n-gram speculation', (
        <label className="settings-live-toggle-control">
          <input
            type="checkbox"
            checked={selectedManagedLlamaPreset.SpeculativeEnabled}
            onChange={(event) => updateManagedLlamaDraft((preset) => { preset.SpeculativeEnabled = event.target.checked; })}
          />
          <span>{selectedManagedLlamaPreset.SpeculativeEnabled ? 'Enabled' : 'Disabled'}</span>
        </label>
      ))}
      {selectedManagedLlamaPreset.SpeculativeEnabled ? renderField('model-presets', 'Speculative type', (
        <select value={selectedManagedLlamaPreset.SpeculativeType} onChange={(event) => updateManagedLlamaDraft((preset) => { preset.SpeculativeType = event.target.value as typeof preset.SpeculativeType; })}>
          {SPECULATIVE_TYPE_OPTIONS.map((option) => (
            <option key={option} value={option}>{option}</option>
          ))}
        </select>
      )) : null}
      {selectedManagedLlamaPreset.SpeculativeEnabled ? renderField('model-presets', 'SpeculativeNgramSizeN', (
        <input type="number" value={selectedManagedLlamaPreset.SpeculativeNgramSizeN} onChange={(event) => updateManagedLlamaDraft((preset) => { preset.SpeculativeNgramSizeN = parseIntegerInput(event.target.value, preset.SpeculativeNgramSizeN); })} />
      )) : null}
      {selectedManagedLlamaPreset.SpeculativeEnabled ? renderField('model-presets', 'SpeculativeNgramSizeM', (
        <input type="number" value={selectedManagedLlamaPreset.SpeculativeNgramSizeM} onChange={(event) => updateManagedLlamaDraft((preset) => { preset.SpeculativeNgramSizeM = parseIntegerInput(event.target.value, preset.SpeculativeNgramSizeM); })} />
      )) : null}
      {selectedManagedLlamaPreset.SpeculativeEnabled ? renderField('model-presets', 'SpeculativeNgramMinHits', (
        <input type="number" value={selectedManagedLlamaPreset.SpeculativeNgramMinHits} onChange={(event) => updateManagedLlamaDraft((preset) => { preset.SpeculativeNgramMinHits = parseIntegerInput(event.target.value, preset.SpeculativeNgramMinHits); })} />
      )) : null}
      {selectedManagedLlamaPreset.SpeculativeEnabled ? renderField('model-presets', 'SpeculativeDraftMax', (
        <input type="number" value={selectedManagedLlamaPreset.SpeculativeDraftMax} onChange={(event) => updateManagedLlamaDraft((preset) => { preset.SpeculativeDraftMax = parseIntegerInput(event.target.value, preset.SpeculativeDraftMax); })} />
      )) : null}
      {selectedManagedLlamaPreset.SpeculativeEnabled ? renderField('model-presets', 'SpeculativeDraftMin', (
        <input type="number" value={selectedManagedLlamaPreset.SpeculativeDraftMin} onChange={(event) => updateManagedLlamaDraft((preset) => { preset.SpeculativeDraftMin = parseIntegerInput(event.target.value, preset.SpeculativeDraftMin); })} />
      )) : null}
      {renderField('model-presets', 'ReasoningBudget', (
        <input type="number" value={selectedManagedLlamaPreset.ReasoningBudget} onChange={(event) => updateManagedLlamaDraft((preset) => { preset.ReasoningBudget = parseIntegerInput(event.target.value, preset.ReasoningBudget); })} />
      ))}
      {renderField('model-presets', 'ReasoningBudgetMessage', (
        <textarea rows={3} value={selectedManagedLlamaPreset.ReasoningBudgetMessage} onChange={(event) => updateManagedLlamaDraft((preset) => { preset.ReasoningBudgetMessage = event.target.value; })} />
      ))}
      {renderField('model-presets', 'StartupTimeoutMs', (
        <input type="number" value={selectedManagedLlamaPreset.StartupTimeoutMs} onChange={(event) => updateManagedLlamaDraft((preset) => { preset.StartupTimeoutMs = parseIntegerInput(event.target.value, preset.StartupTimeoutMs); })} />
      ))}
      {renderField('model-presets', 'HealthcheckTimeoutMs', (
        <input type="number" value={selectedManagedLlamaPreset.HealthcheckTimeoutMs} onChange={(event) => updateManagedLlamaDraft((preset) => { preset.HealthcheckTimeoutMs = parseIntegerInput(event.target.value, preset.HealthcheckTimeoutMs); })} />
      ))}
      {renderField('model-presets', 'HealthcheckIntervalMs', (
        <input type="number" value={selectedManagedLlamaPreset.HealthcheckIntervalMs} onChange={(event) => updateManagedLlamaDraft((preset) => { preset.HealthcheckIntervalMs = parseIntegerInput(event.target.value, preset.HealthcheckIntervalMs); })} />
      ))}
      {renderField('model-presets', 'Managed llama verbose logging', (
        <label className="settings-live-toggle-control">
          <input type="checkbox" checked={selectedManagedLlamaPreset.VerboseLogging} onChange={(event) => updateManagedLlamaDraft((preset) => { preset.VerboseLogging = event.target.checked; })} />
          <span>{selectedManagedLlamaPreset.VerboseLogging ? 'Enabled' : 'Disabled'}</span>
        </label>
      ))}
    </div>
  );
}

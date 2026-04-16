import type { ReactNode } from 'react';

import { applyManagedLlamaPresetSelection } from '../../managed-llama-presets';
import { parseFloatInput, parseIntegerInput } from '../../lib/format';
import { SettingsInlineHelpLabel } from '../../settings/SettingsFields';
import type { SettingsSectionId } from '../../settings-sections';
import type { DashboardConfig, DashboardManagedLlamaPreset } from '../../types';

const KV_CACHE_QUANT_OPTIONS = ['f32', 'f16', 'bf16', 'q8_0', 'q4_0', 'q4_1', 'iq4_nl', 'q5_0', 'q5_1'] as const;

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

  return (
    <div className="settings-live-grid">
      <div className="managed-llama-top-row">
        {renderField('managed-llama', 'Managed preset', (
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
        {renderField('managed-llama', 'Preset name', (
          <input
            value={selectedManagedLlamaPreset.label}
            onChange={(event) => updateManagedLlamaDraft((preset) => { preset.label = event.target.value; })}
          />
        ), 'managed-llama-top-field')}
        {renderField('managed-llama', 'Executable path', (
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
      {renderField('managed-llama', 'Base URL', (
        <input value={selectedManagedLlamaPreset.BaseUrl} onChange={(event) => updateManagedLlamaDraft((preset) => { preset.BaseUrl = event.target.value; })} />
      ))}
      {renderField('managed-llama', 'Bind host', (
        <input value={selectedManagedLlamaPreset.BindHost} onChange={(event) => updateManagedLlamaDraft((preset) => { preset.BindHost = event.target.value; })} />
      ))}
      {renderField('managed-llama', 'Port', (
        <input type="number" value={selectedManagedLlamaPreset.Port} onChange={(event) => updateManagedLlamaDraft((preset) => { preset.Port = parseIntegerInput(event.target.value, preset.Port); })} />
      ))}
      {renderField('managed-llama', 'Model path (.gguf)', (
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
      {renderField('managed-llama', 'NumCtx', (
        <input type="number" value={selectedManagedLlamaPreset.NumCtx} onChange={(event) => updateManagedLlamaDraft((preset) => { preset.NumCtx = parseIntegerInput(event.target.value, preset.NumCtx); })} />
      ))}
      {renderField('managed-llama', 'GpuLayers', (
        <input type="number" value={selectedManagedLlamaPreset.GpuLayers} onChange={(event) => updateManagedLlamaDraft((preset) => { preset.GpuLayers = parseIntegerInput(event.target.value, preset.GpuLayers); })} />
      ))}
      {renderField('managed-llama', 'Threads', (
        <input type="number" value={selectedManagedLlamaPreset.Threads} onChange={(event) => updateManagedLlamaDraft((preset) => { preset.Threads = parseIntegerInput(event.target.value, preset.Threads); })} />
      ))}
      {renderField('managed-llama', 'Flash attention', (
        <label className="settings-live-toggle-control">
          <input type="checkbox" checked={selectedManagedLlamaPreset.FlashAttention} onChange={(event) => updateManagedLlamaDraft((preset) => { preset.FlashAttention = event.target.checked; })} />
          <span>{selectedManagedLlamaPreset.FlashAttention ? 'Enabled' : 'Disabled'}</span>
        </label>
      ))}
      {renderField('managed-llama', 'ParallelSlots', (
        <input type="number" value={selectedManagedLlamaPreset.ParallelSlots} onChange={(event) => updateManagedLlamaDraft((preset) => { preset.ParallelSlots = parseIntegerInput(event.target.value, preset.ParallelSlots); })} />
      ))}
      {renderField('managed-llama', 'BatchSize', (
        <input type="number" value={selectedManagedLlamaPreset.BatchSize} onChange={(event) => updateManagedLlamaDraft((preset) => { preset.BatchSize = parseIntegerInput(event.target.value, preset.BatchSize); })} />
      ))}
      {renderField('managed-llama', 'UBatchSize', (
        <input type="number" value={selectedManagedLlamaPreset.UBatchSize} onChange={(event) => updateManagedLlamaDraft((preset) => { preset.UBatchSize = parseIntegerInput(event.target.value, preset.UBatchSize); })} />
      ))}
      {renderField('managed-llama', 'CacheRam', (
        <input type="number" value={selectedManagedLlamaPreset.CacheRam} onChange={(event) => updateManagedLlamaDraft((preset) => { preset.CacheRam = parseIntegerInput(event.target.value, preset.CacheRam); })} />
      ))}
      {renderField('managed-llama', 'KV cache quant', (
        <select value={selectedManagedLlamaPreset.KvCacheQuantization} onChange={(event) => updateManagedLlamaDraft((preset) => { preset.KvCacheQuantization = event.target.value as typeof preset.KvCacheQuantization; })}>
          {KV_CACHE_QUANT_OPTIONS.map((option) => (
            <option key={option} value={option}>{option}</option>
          ))}
        </select>
      ))}
      {renderField('managed-llama', 'MaxTokens', (
        <input type="number" value={selectedManagedLlamaPreset.MaxTokens} onChange={(event) => updateManagedLlamaDraft((preset) => { preset.MaxTokens = parseIntegerInput(event.target.value, preset.MaxTokens); })} />
      ))}
      {renderField('managed-llama', 'Temperature', (
        <input type="number" step="0.01" value={selectedManagedLlamaPreset.Temperature} onChange={(event) => updateManagedLlamaDraft((preset) => { preset.Temperature = parseFloatInput(event.target.value, preset.Temperature); })} />
      ))}
      {renderField('managed-llama', 'TopP', (
        <input type="number" step="0.01" value={selectedManagedLlamaPreset.TopP} onChange={(event) => updateManagedLlamaDraft((preset) => { preset.TopP = parseFloatInput(event.target.value, preset.TopP); })} />
      ))}
      {renderField('managed-llama', 'TopK', (
        <input type="number" value={selectedManagedLlamaPreset.TopK} onChange={(event) => updateManagedLlamaDraft((preset) => { preset.TopK = parseIntegerInput(event.target.value, preset.TopK); })} />
      ))}
      {renderField('managed-llama', 'MinP', (
        <input type="number" step="0.01" value={selectedManagedLlamaPreset.MinP} onChange={(event) => updateManagedLlamaDraft((preset) => { preset.MinP = parseFloatInput(event.target.value, preset.MinP); })} />
      ))}
      {renderField('managed-llama', 'PresencePenalty', (
        <input type="number" step="0.01" value={selectedManagedLlamaPreset.PresencePenalty} onChange={(event) => updateManagedLlamaDraft((preset) => { preset.PresencePenalty = parseFloatInput(event.target.value, preset.PresencePenalty); })} />
      ))}
      {renderField('managed-llama', 'RepetitionPenalty', (
        <input type="number" step="0.01" value={selectedManagedLlamaPreset.RepetitionPenalty} onChange={(event) => updateManagedLlamaDraft((preset) => { preset.RepetitionPenalty = parseFloatInput(event.target.value, preset.RepetitionPenalty); })} />
      ))}
      {renderField('managed-llama', 'Reasoning', (
        <select value={selectedManagedLlamaPreset.Reasoning} onChange={(event) => updateManagedLlamaDraft((preset) => { preset.Reasoning = event.target.value as 'on' | 'off' | 'auto'; })}>
          <option value="off">off</option>
          <option value="on">on</option>
          <option value="auto">auto</option>
        </select>
      ))}
      {renderField('managed-llama', 'ReasoningBudget', (
        <input type="number" value={selectedManagedLlamaPreset.ReasoningBudget} onChange={(event) => updateManagedLlamaDraft((preset) => { preset.ReasoningBudget = parseIntegerInput(event.target.value, preset.ReasoningBudget); })} />
      ))}
      {renderField('managed-llama', 'ReasoningBudgetMessage', (
        <textarea rows={3} value={selectedManagedLlamaPreset.ReasoningBudgetMessage} onChange={(event) => updateManagedLlamaDraft((preset) => { preset.ReasoningBudgetMessage = event.target.value; })} />
      ))}
      {renderField('managed-llama', 'StartupTimeoutMs', (
        <input type="number" value={selectedManagedLlamaPreset.StartupTimeoutMs} onChange={(event) => updateManagedLlamaDraft((preset) => { preset.StartupTimeoutMs = parseIntegerInput(event.target.value, preset.StartupTimeoutMs); })} />
      ))}
      {renderField('managed-llama', 'HealthcheckTimeoutMs', (
        <input type="number" value={selectedManagedLlamaPreset.HealthcheckTimeoutMs} onChange={(event) => updateManagedLlamaDraft((preset) => { preset.HealthcheckTimeoutMs = parseIntegerInput(event.target.value, preset.HealthcheckTimeoutMs); })} />
      ))}
      {renderField('managed-llama', 'HealthcheckIntervalMs', (
        <input type="number" value={selectedManagedLlamaPreset.HealthcheckIntervalMs} onChange={(event) => updateManagedLlamaDraft((preset) => { preset.HealthcheckIntervalMs = parseIntegerInput(event.target.value, preset.HealthcheckIntervalMs); })} />
      ))}
      {renderField('managed-llama', 'Managed llama verbose logging', (
        <label className="settings-live-toggle-control">
          <input type="checkbox" checked={selectedManagedLlamaPreset.VerboseLogging} onChange={(event) => updateManagedLlamaDraft((preset) => { preset.VerboseLogging = event.target.checked; })} />
          <span>{selectedManagedLlamaPreset.VerboseLogging ? 'Enabled' : 'Disabled'}</span>
        </label>
      ))}
    </div>
  );
}

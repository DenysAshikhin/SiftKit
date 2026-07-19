import React from 'react';
import type { ReactNode } from 'react';

import { applyModelPresetSelection } from '../../model-runtime-presets';
import { deriveRuntimeModelId } from '../../settings-runtime';
import { parseFloatInput, parseIntegerInput } from '../../lib/format';
import { SettingsInlineHelpLabel } from '../../settings/SettingsFields';
import { getExl3CacheMode, getPresetFieldAvailability } from '../../../../src/inference-presets/preset-compatibility.js';
import type { SettingsSectionId } from '../../settings-sections';
import type {
  DashboardConfig,
  DashboardModelRuntimePreset,
  DashboardManagedLlamaSpeculativeType,
  ModelPresetField,
} from '../../types';

const KV_CACHE_QUANT_OPTIONS = ['f32', 'f16', 'bf16', 'q8_0', 'q4_0', 'q4_1', 'iq4_nl', 'q5_0', 'q5_1', 'q8_0/q4_0', 'q8_0/q5_0'] as const;
const SPECULATIVE_TYPE_OPTIONS = ['draft-simple', 'draft-eagle3', 'draft-mtp', 'ngram-simple', 'ngram-map-k', 'ngram-map-k4v', 'ngram-mod', 'ngram-cache'] as const;
const LOCAL_LLAMA_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]', '0.0.0.0']);

type RenderField = (
  sectionId: SettingsSectionId,
  label: string,
  children: ReactNode,
  className?: string,
) => ReactNode;

type ModelPresetsSectionProps = {
  dashboardConfig: DashboardConfig | null;
  selectedModelPreset: DashboardModelRuntimePreset | null;
  settingsActionBusy: boolean;
  settingsPathPickerBusyTarget: 'ExecutablePath' | 'ModelPath' | null;
  renderField: RenderField;
  updateSettingsDraft(updater: (next: DashboardConfig) => void): void;
  updateModelPresetDraft(updater: (preset: DashboardModelRuntimePreset) => void): void;
  onAddModelPreset(): void;
  onDeleteModelPreset(presetId: string): void;
  onPickModelPresetPath(target: 'ExecutablePath' | 'ModelPath'): Promise<void>;
  onTestLlamaCppBaseUrl(baseUrl: string, timeoutMs: number): Promise<void>;
};

function isRemoteLlamaBaseUrl(baseUrl: string): boolean {
  try {
    const parsed = new URL(baseUrl);
    return !LOCAL_LLAMA_HOSTS.has(parsed.hostname.toLowerCase()) && !parsed.hostname.startsWith('127.');
  } catch {
    return false;
  }
}

const NGRAM_SIZE_SPECULATIVE_TYPES = new Set<DashboardManagedLlamaSpeculativeType>([
  'ngram-simple',
  'ngram-map-k',
  'ngram-map-k4v',
]);

function isDraftSpeculativeType(type: DashboardManagedLlamaSpeculativeType): boolean {
  return type.startsWith('draft-');
}

function isNgramSpeculativeType(type: DashboardManagedLlamaSpeculativeType): boolean {
  return type.startsWith('ngram-');
}

function renderCompatibilityControl(
  preset: DashboardModelRuntimePreset,
  field: ModelPresetField,
  control: ReactNode,
): ReactNode {
  const availability = getPresetFieldAvailability(preset.Backend, field);
  return (
    <div className="settings-live-stack">
      <fieldset className="settings-compatibility-control" disabled={!availability.enabled}>{control}</fieldset>
      {availability.reason ? <span className="hint">{availability.reason}</span> : null}
    </div>
  );
}

export function ModelPresetsSection({
  dashboardConfig,
  selectedModelPreset,
  settingsActionBusy,
  settingsPathPickerBusyTarget,
  renderField,
  updateSettingsDraft,
  updateModelPresetDraft,
  onAddModelPreset,
  onDeleteModelPreset,
  onPickModelPresetPath,
  onTestLlamaCppBaseUrl,
}: ModelPresetsSectionProps) {
  if (!dashboardConfig || !selectedModelPreset) {
    return null;
  }
  const reasoningEnabled = selectedModelPreset.Reasoning === 'on';
  const reasoningContentEnabled = reasoningEnabled && selectedModelPreset.ReasoningContent;
  const baseUrl = selectedModelPreset.BaseUrl || '';
  const remoteLlamaBaseUrl = isRemoteLlamaBaseUrl(baseUrl);
  const speculativeType = selectedModelPreset.SpeculativeType;
  const speculativeEnabled = selectedModelPreset.SpeculativeEnabled;
  const draftSpeculativeType = speculativeEnabled && isDraftSpeculativeType(speculativeType);
  const ngramModSpeculativeType = speculativeEnabled && speculativeType === 'ngram-mod';
  const ngramSizeSpeculativeType = speculativeEnabled && NGRAM_SIZE_SPECULATIVE_TYPES.has(speculativeType);
  const mtpCombineAvailable = speculativeEnabled && isNgramSpeculativeType(speculativeType);
  const mtpCombineEnabled = mtpCombineAvailable && selectedModelPreset.SpeculativeMtpEnabled;
  const draftTokenFields = draftSpeculativeType || mtpCombineEnabled;
  const mtpParallelSlotsWarning = speculativeEnabled
    && (speculativeType === 'draft-mtp' || mtpCombineEnabled)
    && selectedModelPreset.ParallelSlots > 1;

  return (
    <div className="settings-live-grid">
      <div className="model-presets-top-row">
        {renderField('model-presets', 'Model preset', (
          <div className="settings-preset-library">
            <div className="settings-preset-toolbar">
              <label className="settings-preset-selector">
                <span className="settings-preset-inline-label"><SettingsInlineHelpLabel label="Preset" helpText="Pick which model/runtime preset to edit and launch." /></span>
                <select
                  value={dashboardConfig.Server.ModelPresets.ActivePresetId}
                  onChange={(event) => updateSettingsDraft((next) => {
                    applyModelPresetSelection(next, event.target.value);
                  })}
                  disabled={dashboardConfig.Server.ModelPresets.Presets.length === 0}
                >
                  {dashboardConfig.Server.ModelPresets.Presets.map((preset) => (
                    <option key={preset.id} value={preset.id}>{preset.label}</option>
                  ))}
                </select>
              </label>
              <div className="settings-preset-library-actions">
                <button type="button" onClick={onAddModelPreset}>Add Preset</button>
                <button
                  type="button"
                  onClick={() => { onDeleteModelPreset(selectedModelPreset.id); }}
                  disabled={dashboardConfig.Server.ModelPresets.Presets.length <= 1}
                >
                  Delete
                </button>
              </div>
            </div>
          </div>
        ), 'model-presets-top-field')}
        {renderField('model-presets', 'Preset name', (
          <input
            value={selectedModelPreset.label}
            onChange={(event) => updateModelPresetDraft((preset) => { preset.label = event.target.value; })}
          />
        ), 'model-presets-top-field')}
        {renderField('model-presets', 'Preset backend', (
          <select
            aria-label="Preset backend"
            value={selectedModelPreset.Backend}
            onChange={(event) => updateModelPresetDraft((preset) => {
              preset.Backend = event.target.value === 'exl3' ? 'exl3' : 'llama';
            })}
          >
            <option value="llama">llama.cpp</option>
            <option value="exl3">EXL3</option>
          </select>
        ), 'model-presets-top-field')}
        {!selectedModelPreset.ExternalServerEnabled ? renderField('model-presets', 'Executable path', (
          renderCompatibilityControl(selectedModelPreset, 'ExecutablePath', (
            <div className="settings-live-nav-control">
              <input
                value={selectedModelPreset.ExecutablePath || ''}
                onChange={(event) => updateModelPresetDraft((preset) => {
                  const value = event.target.value.trim();
                  preset.ExecutablePath = value || null;
                })}
              />
              <button type="button" onClick={() => { void onPickModelPresetPath('ExecutablePath'); }} disabled={settingsActionBusy}>
                {settingsPathPickerBusyTarget === 'ExecutablePath' ? 'Opening...' : 'Browse...'}
              </button>
            </div>
          ))
        ), 'model-presets-top-field') : null}
      </div>
      {renderField('model-presets', 'External inference server', (
        <label className="settings-live-toggle-control">
          <input
            type="checkbox"
            checked={selectedModelPreset.ExternalServerEnabled}
            onChange={(event) => updateModelPresetDraft((preset) => { preset.ExternalServerEnabled = event.target.checked; })}
          />
          <span>{selectedModelPreset.ExternalServerEnabled ? 'Enabled' : 'Disabled'}</span>
        </label>
      ))}
      {renderField('model-presets', 'Base URL', (
        <div className="settings-live-stack">
          <div className="settings-live-nav-control">
            <input value={baseUrl} onChange={(event) => updateModelPresetDraft((preset) => { preset.BaseUrl = event.target.value || null; })} />
            <button
              type="button"
              disabled={settingsActionBusy}
              onClick={() => {
                void onTestLlamaCppBaseUrl(
                  baseUrl,
                  selectedModelPreset.HealthcheckTimeoutMs,
                );
              }}
            >
              Test
            </button>
          </div>
          {remoteLlamaBaseUrl ? (
            <div className="settings-live-warning" role="alert">
              Remote llama.cpp URL detected. If this llama server is on another machine, the backend URL also needs to use a non-local host.
            </div>
          ) : null}
        </div>
      ), remoteLlamaBaseUrl ? 'settings-live-field-danger' : undefined)}
      {renderField('model-presets', 'Bind host', (
        <input value={selectedModelPreset.BindHost} onChange={(event) => updateModelPresetDraft((preset) => { preset.BindHost = event.target.value; })} />
      ))}
      {renderField('model-presets', 'Port', (
        <input type="number" value={selectedModelPreset.Port} onChange={(event) => updateModelPresetDraft((preset) => { preset.Port = parseIntegerInput(event.target.value, preset.Port); })} />
      ))}
      {!selectedModelPreset.ExternalServerEnabled ? renderField(
        'model-presets',
        selectedModelPreset.Backend === 'exl3' ? 'Model directory (EXL3)' : 'Model path (.gguf)',
        (
          <div className="settings-live-nav-control">
            <input
              value={selectedModelPreset.ModelPath || ''}
              onChange={(event) => updateModelPresetDraft((preset) => {
                const value = event.target.value.trim();
                preset.ModelPath = value || null;
                preset.Model = deriveRuntimeModelId(preset.ModelPath) || preset.Model;
              })}
            />
            <button type="button" onClick={() => { void onPickModelPresetPath('ModelPath'); }} disabled={settingsActionBusy}>
              {settingsPathPickerBusyTarget === 'ModelPath' ? 'Opening...' : 'Browse...'}
            </button>
          </div>
        ),
      ) : null}
      {renderField('model-presets', 'NumCtx', (
        <input type="number" value={selectedModelPreset.NumCtx} onChange={(event) => updateModelPresetDraft((preset) => { preset.NumCtx = parseIntegerInput(event.target.value, preset.NumCtx); })} />
      ))}
      {renderField('model-presets', 'GpuLayers', (
        renderCompatibilityControl(selectedModelPreset, 'GpuLayers', (
          <input type="number" value={selectedModelPreset.GpuLayers} onChange={(event) => updateModelPresetDraft((preset) => { preset.GpuLayers = parseIntegerInput(event.target.value, preset.GpuLayers); })} />
        ))
      ))}
      {renderField('model-presets', 'Threads', (
        renderCompatibilityControl(selectedModelPreset, 'Threads', (
          <input type="number" value={selectedModelPreset.Threads} onChange={(event) => updateModelPresetDraft((preset) => { preset.Threads = parseIntegerInput(event.target.value, preset.Threads); })} />
        ))
      ))}
      {renderField('model-presets', 'NcpuMoe', (
        renderCompatibilityControl(selectedModelPreset, 'NcpuMoe', (
          <input type="number" value={selectedModelPreset.NcpuMoe} onChange={(event) => updateModelPresetDraft((preset) => { preset.NcpuMoe = parseIntegerInput(event.target.value, preset.NcpuMoe); })} />
        ))
      ))}
      {renderField('model-presets', 'Flash attention', (
        renderCompatibilityControl(selectedModelPreset, 'FlashAttention', (
          <label className="settings-live-toggle-control">
            <input type="checkbox" checked={selectedModelPreset.FlashAttention} onChange={(event) => updateModelPresetDraft((preset) => { preset.FlashAttention = event.target.checked; })} />
            <span>{selectedModelPreset.FlashAttention ? 'Enabled' : 'Disabled'}</span>
          </label>
        ))
      ))}
      {renderField('model-presets', 'ParallelSlots', (
        <input type="number" value={selectedModelPreset.ParallelSlots} onChange={(event) => updateModelPresetDraft((preset) => { preset.ParallelSlots = parseIntegerInput(event.target.value, preset.ParallelSlots); })} />
      ))}
      {renderField('model-presets', 'BatchSize', (
        renderCompatibilityControl(selectedModelPreset, 'BatchSize', (
          <input type="number" value={selectedModelPreset.BatchSize} onChange={(event) => updateModelPresetDraft((preset) => { preset.BatchSize = parseIntegerInput(event.target.value, preset.BatchSize); })} />
        ))
      ))}
      {renderField('model-presets', 'UBatchSize', (
        renderCompatibilityControl(selectedModelPreset, 'UBatchSize', (
          <input type="number" value={selectedModelPreset.UBatchSize} onChange={(event) => updateModelPresetDraft((preset) => { preset.UBatchSize = parseIntegerInput(event.target.value, preset.UBatchSize); })} />
        ))
      ))}
      {renderField('model-presets', 'CacheRam', (
        renderCompatibilityControl(selectedModelPreset, 'CacheRam', (
          <input type="number" value={selectedModelPreset.CacheRam} onChange={(event) => updateModelPresetDraft((preset) => { preset.CacheRam = parseIntegerInput(event.target.value, preset.CacheRam); })} />
        ))
      ))}
      {renderField('model-presets', 'KV cache quant', (
        renderCompatibilityControl(selectedModelPreset, 'KvCacheQuantization', (
          <select value={selectedModelPreset.KvCacheQuantization} onChange={(event) => updateModelPresetDraft((preset) => { const next = KV_CACHE_QUANT_OPTIONS.find((option) => option === event.target.value); if (next) preset.KvCacheQuantization = next; })}>
            {KV_CACHE_QUANT_OPTIONS.map((option) => (
              <option key={option} value={option} disabled={selectedModelPreset.Backend === 'exl3' && getExl3CacheMode(option) === null}>{option}</option>
            ))}
          </select>
        ))
      ))}
      {renderField('model-presets', 'MaxTokens', (
        <input type="number" value={selectedModelPreset.MaxTokens} onChange={(event) => updateModelPresetDraft((preset) => { preset.MaxTokens = parseIntegerInput(event.target.value, preset.MaxTokens); })} />
      ))}
      {renderField('model-presets', 'Temperature', (
        <input type="number" step="0.01" value={selectedModelPreset.Temperature} onChange={(event) => updateModelPresetDraft((preset) => { preset.Temperature = parseFloatInput(event.target.value, preset.Temperature); })} />
      ))}
      {renderField('model-presets', 'TopP', (
        <input type="number" step="0.01" value={selectedModelPreset.TopP} onChange={(event) => updateModelPresetDraft((preset) => { preset.TopP = parseFloatInput(event.target.value, preset.TopP); })} />
      ))}
      {renderField('model-presets', 'TopK', (
        <input type="number" value={selectedModelPreset.TopK} onChange={(event) => updateModelPresetDraft((preset) => { preset.TopK = parseIntegerInput(event.target.value, preset.TopK); })} />
      ))}
      {renderField('model-presets', 'MinP', (
        <input type="number" step="0.01" value={selectedModelPreset.MinP} onChange={(event) => updateModelPresetDraft((preset) => { preset.MinP = parseFloatInput(event.target.value, preset.MinP); })} />
      ))}
      {renderField('model-presets', 'PresencePenalty', (
        <input type="number" step="0.01" value={selectedModelPreset.PresencePenalty} onChange={(event) => updateModelPresetDraft((preset) => { preset.PresencePenalty = parseFloatInput(event.target.value, preset.PresencePenalty); })} />
      ))}
      {renderField('model-presets', 'RepetitionPenalty', (
        <input type="number" step="0.01" value={selectedModelPreset.RepetitionPenalty} onChange={(event) => updateModelPresetDraft((preset) => { preset.RepetitionPenalty = parseFloatInput(event.target.value, preset.RepetitionPenalty); })} />
      ))}
      {renderField('model-presets', 'Reasoning', (
        <select
          value={selectedModelPreset.Reasoning}
          onChange={(event) => updateModelPresetDraft((preset) => {
            preset.Reasoning = event.target.value === 'on' ? 'on' : 'off';
            if (preset.Reasoning !== 'on') {
              preset.ReasoningContent = false;
              preset.PreserveThinking = false;
              preset.MaintainPerStepThinking = false;
            } else {
              preset.MaintainPerStepThinking = true;
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
            checked={selectedModelPreset.ReasoningContent}
            onChange={(event) => updateModelPresetDraft((preset) => {
              preset.ReasoningContent = event.target.checked;
              if (!preset.ReasoningContent) {
                preset.PreserveThinking = false;
              }
            })}
          />
          <span>{selectedModelPreset.ReasoningContent ? 'Enabled' : 'Disabled'}</span>
        </label>
      )) : null}
      {reasoningContentEnabled ? renderField('model-presets', 'Preserve thinking', (
        <label className="settings-live-toggle-control">
          <input
            type="checkbox"
            checked={selectedModelPreset.PreserveThinking}
            onChange={(event) => updateModelPresetDraft((preset) => { preset.PreserveThinking = event.target.checked; })}
          />
          <span>{selectedModelPreset.PreserveThinking ? 'Enabled' : 'Disabled'}</span>
        </label>
      )) : null}
      {reasoningEnabled ? renderField('model-presets', 'Maintain per step thinking', (
        <label className="settings-live-toggle-control">
          <input
            type="checkbox"
            checked={selectedModelPreset.MaintainPerStepThinking}
            onChange={(event) => updateModelPresetDraft((preset) => { preset.MaintainPerStepThinking = event.target.checked; })}
          />
          <span>{selectedModelPreset.MaintainPerStepThinking ? 'Enabled' : 'Disabled'}</span>
        </label>
      )) : null}
      {renderField('model-presets', 'Enable speculative decoding', (
        <label className="settings-live-toggle-control">
          <input
            type="checkbox"
            checked={selectedModelPreset.SpeculativeEnabled}
            onChange={(event) => updateModelPresetDraft((preset) => { preset.SpeculativeEnabled = event.target.checked; })}
          />
          <span>{selectedModelPreset.SpeculativeEnabled ? 'Enabled' : 'Disabled'}</span>
        </label>
      ))}
      {selectedModelPreset.SpeculativeEnabled ? renderField('model-presets', 'Speculative type', (
        renderCompatibilityControl(selectedModelPreset, 'SpeculativeType', (
          <select value={selectedModelPreset.SpeculativeType} onChange={(event) => updateModelPresetDraft((preset) => { const next = SPECULATIVE_TYPE_OPTIONS.find((option) => option === event.target.value); if (next) preset.SpeculativeType = next; })}>
            {SPECULATIVE_TYPE_OPTIONS.map((option) => (
              <option key={option} value={option} disabled={selectedModelPreset.Backend === 'exl3' && option !== 'draft-mtp'}>{option}</option>
            ))}
          </select>
        ))
      )) : null}
      {mtpCombineAvailable ? renderField('model-presets', 'Combine with MTP', (
        renderCompatibilityControl(selectedModelPreset, 'SpeculativeMtpEnabled', (
          <label className="settings-live-toggle-control">
            <input
              type="checkbox"
              checked={selectedModelPreset.SpeculativeMtpEnabled}
              onChange={(event) => updateModelPresetDraft((preset) => { preset.SpeculativeMtpEnabled = event.target.checked; })}
            />
            <span>{selectedModelPreset.SpeculativeMtpEnabled ? 'Enabled' : 'Disabled'}</span>
          </label>
        ))
      )) : null}
      {mtpParallelSlotsWarning ? (
        <div className="settings-live-warning" role="alert">
          MTP speculative decoding does not support parallel slots above 1 in the upstream llama.cpp implementation.
        </div>
      ) : null}
      {ngramSizeSpeculativeType ? renderField('model-presets', 'SpeculativeNgramSizeN', (
        renderCompatibilityControl(selectedModelPreset, 'SpeculativeNgramSizeN', (
          <input type="number" value={selectedModelPreset.SpeculativeNgramSizeN} onChange={(event) => updateModelPresetDraft((preset) => { preset.SpeculativeNgramSizeN = parseIntegerInput(event.target.value, preset.SpeculativeNgramSizeN); })} />
        ))
      )) : null}
      {ngramSizeSpeculativeType ? renderField('model-presets', 'SpeculativeNgramSizeM', (
        renderCompatibilityControl(selectedModelPreset, 'SpeculativeNgramSizeM', (
          <input type="number" value={selectedModelPreset.SpeculativeNgramSizeM} onChange={(event) => updateModelPresetDraft((preset) => { preset.SpeculativeNgramSizeM = parseIntegerInput(event.target.value, preset.SpeculativeNgramSizeM); })} />
        ))
      )) : null}
      {ngramSizeSpeculativeType ? renderField('model-presets', 'SpeculativeNgramMinHits', (
        renderCompatibilityControl(selectedModelPreset, 'SpeculativeNgramMinHits', (
          <input type="number" value={selectedModelPreset.SpeculativeNgramMinHits} onChange={(event) => updateModelPresetDraft((preset) => { preset.SpeculativeNgramMinHits = parseIntegerInput(event.target.value, preset.SpeculativeNgramMinHits); })} />
        ))
      )) : null}
      {ngramModSpeculativeType ? renderField('model-presets', 'SpeculativeNgramModNMatch', (
        renderCompatibilityControl(selectedModelPreset, 'SpeculativeNgramModNMatch', (
          <input type="number" value={selectedModelPreset.SpeculativeNgramModNMatch} onChange={(event) => updateModelPresetDraft((preset) => { preset.SpeculativeNgramModNMatch = parseIntegerInput(event.target.value, preset.SpeculativeNgramModNMatch); })} />
        ))
      )) : null}
      {ngramModSpeculativeType ? renderField('model-presets', 'SpeculativeNgramModNMin', (
        renderCompatibilityControl(selectedModelPreset, 'SpeculativeNgramModNMin', (
          <input type="number" value={selectedModelPreset.SpeculativeNgramModNMin} onChange={(event) => updateModelPresetDraft((preset) => { preset.SpeculativeNgramModNMin = parseIntegerInput(event.target.value, preset.SpeculativeNgramModNMin); })} />
        ))
      )) : null}
      {ngramModSpeculativeType ? renderField('model-presets', 'SpeculativeNgramModNMax', (
        renderCompatibilityControl(selectedModelPreset, 'SpeculativeNgramModNMax', (
          <input type="number" value={selectedModelPreset.SpeculativeNgramModNMax} onChange={(event) => updateModelPresetDraft((preset) => { preset.SpeculativeNgramModNMax = parseIntegerInput(event.target.value, preset.SpeculativeNgramModNMax); })} />
        ))
      )) : null}
      {draftTokenFields ? renderField('model-presets', 'SpeculativeDraftMax', (
        <input type="number" value={selectedModelPreset.SpeculativeDraftMax} onChange={(event) => updateModelPresetDraft((preset) => { preset.SpeculativeDraftMax = parseIntegerInput(event.target.value, preset.SpeculativeDraftMax); })} />
      )) : null}
      {draftTokenFields ? renderField('model-presets', 'SpeculativeDraftMin', (
        renderCompatibilityControl(selectedModelPreset, 'SpeculativeDraftMin', (
          <input type="number" value={selectedModelPreset.SpeculativeDraftMin} onChange={(event) => updateModelPresetDraft((preset) => { preset.SpeculativeDraftMin = parseIntegerInput(event.target.value, preset.SpeculativeDraftMin); })} />
        ))
      )) : null}
      {renderField('model-presets', 'ReasoningBudget', (
        renderCompatibilityControl(selectedModelPreset, 'ReasoningBudget', (
          <input type="number" value={selectedModelPreset.ReasoningBudget} onChange={(event) => updateModelPresetDraft((preset) => { preset.ReasoningBudget = parseIntegerInput(event.target.value, preset.ReasoningBudget); })} />
        ))
      ))}
      {renderField('model-presets', 'ReasoningBudgetMessage', (
        renderCompatibilityControl(selectedModelPreset, 'ReasoningBudgetMessage', (
          <textarea rows={3} value={selectedModelPreset.ReasoningBudgetMessage || ''} onChange={(event) => updateModelPresetDraft((preset) => { preset.ReasoningBudgetMessage = event.target.value || null; })} />
        ))
      ))}
      {renderField('model-presets', 'StartupTimeoutMs', (
        <input type="number" value={selectedModelPreset.StartupTimeoutMs} onChange={(event) => updateModelPresetDraft((preset) => { preset.StartupTimeoutMs = parseIntegerInput(event.target.value, preset.StartupTimeoutMs); })} />
      ))}
      {renderField('model-presets', 'HealthcheckTimeoutMs', (
        <input type="number" value={selectedModelPreset.HealthcheckTimeoutMs} onChange={(event) => updateModelPresetDraft((preset) => { preset.HealthcheckTimeoutMs = parseIntegerInput(event.target.value, preset.HealthcheckTimeoutMs); })} />
      ))}
      {renderField('model-presets', 'HealthcheckIntervalMs', (
        <input type="number" value={selectedModelPreset.HealthcheckIntervalMs} onChange={(event) => updateModelPresetDraft((preset) => { preset.HealthcheckIntervalMs = parseIntegerInput(event.target.value, preset.HealthcheckIntervalMs); })} />
      ))}
      {renderField('model-presets', 'SleepIdleSeconds', (
        <input type="number" value={selectedModelPreset.SleepIdleSeconds} onChange={(event) => updateModelPresetDraft((preset) => { preset.SleepIdleSeconds = parseIntegerInput(event.target.value, preset.SleepIdleSeconds); })} />
      ))}
      {renderField('model-presets', 'Verbose logging', (
        renderCompatibilityControl(selectedModelPreset, 'VerboseLogging', (
          <label className="settings-live-toggle-control">
            <input type="checkbox" checked={selectedModelPreset.VerboseLogging} onChange={(event) => updateModelPresetDraft((preset) => { preset.VerboseLogging = event.target.checked; })} />
            <span>{selectedModelPreset.VerboseLogging ? 'Enabled' : 'Disabled'}</span>
          </label>
        ))
      ))}
    </div>
  );
}

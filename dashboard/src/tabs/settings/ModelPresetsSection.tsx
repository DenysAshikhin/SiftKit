import React from 'react';
import type { ReactNode } from 'react';

import { applyModelPresetSelection } from '../../model-runtime-presets';
import { deriveRuntimeModelId } from '../../settings-runtime';
import { parseFloatInput, parseIntegerInput } from '../../lib/format';
import { getExl3CacheMode, getPresetFieldAvailability } from '../../../../src/inference-presets/preset-compatibility.js';
import { getInferenceRuntimeStatus } from '../../api';
import { MODEL_PRESET_GROUPS, summarizeModelPresetGroup, type ModelPresetGroupId } from './model-preset-groups';
import { SettingsSectionField } from '../../settings/SettingsFields';
import type { InferenceRuntimeStatus } from '@siftkit/contracts';
import type {
  DashboardConfig,
  DashboardModelRuntimePreset,
  DashboardManagedLlamaSpeculativeType,
  ModelPresetField,
} from '../../types';

const KV_CACHE_QUANT_OPTIONS = ['f32', 'f16', 'bf16', 'q8_0', 'q4_0', 'q4_1', 'iq4_nl', 'q5_0', 'q5_1', 'q8_0/q4_0', 'q8_0/q5_0'] as const;
const SPECULATIVE_TYPE_OPTIONS = ['draft-simple', 'draft-eagle3', 'draft-mtp', 'ngram-simple', 'ngram-map-k', 'ngram-map-k4v', 'ngram-mod', 'ngram-cache'] as const;
const EXL3_SPECULATIVE_TYPE_OPTIONS = ['draft-mtp'] as const;
const LOCAL_LLAMA_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]', '0.0.0.0']);

type ModelPresetsSectionProps = {
  dashboardConfig: DashboardConfig | null;
  selectedModelPreset: DashboardModelRuntimePreset | null;
  settingsActionBusy: boolean;
  settingsPathPickerBusyTarget: 'ExecutablePath' | 'ModelPath' | null;
  updateSettingsDraft(updater: (next: DashboardConfig) => void): void;
  updateModelPresetDraft(updater: (preset: DashboardModelRuntimePreset) => void): void;
  onAddModelPreset(): void;
  onDeleteModelPreset(presetId: string): void;
  onPickModelPresetPath(target: 'ExecutablePath' | 'ModelPath'): Promise<void>;
  onTestLlamaCppBaseUrl(baseUrl: string, timeoutMs: number): Promise<void>;
};

const GROUP_TITLES: Record<ModelPresetGroupId, string> = {
  'identity-launch': 'Identity & launch',
  'memory-compute': 'Memory & compute',
  sampling: 'Sampling',
  reasoning: 'Reasoning',
  speculative: 'Speculative decoding',
  lifecycle: 'Lifecycle & health',
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
  const availability = getPresetFieldAvailability(preset, field);
  return (
    <div className="settings-live-stack">
      <fieldset className="settings-compatibility-control" disabled={!availability.enabled}>{control}</fieldset>
      {availability.reason ? <span className="hint">{availability.reason}</span> : null}
    </div>
  );
}

function ModelPresetGroup({ id, open, summary, onToggle, children }: {
  id: ModelPresetGroupId;
  open: boolean;
  summary: string;
  onToggle(id: ModelPresetGroupId, next: boolean): void;
  children: ReactNode;
}) {
  return (
    <details className="mpg" open={open} onToggle={(event) => onToggle(id, event.currentTarget.open)}>
      <summary>
        <span className="chev">▶</span>
        <span className="gt">{GROUP_TITLES[id]}</span>
        <span className="gsum">{summary}</span>
      </summary>
      <div className="gbody"><div className="fgrid flat">{children}</div></div>
    </details>
  );
}

export function ModelPresetsSection({
  dashboardConfig,
  selectedModelPreset,
  settingsActionBusy,
  settingsPathPickerBusyTarget,
  updateSettingsDraft,
  updateModelPresetDraft,
  onAddModelPreset,
  onDeleteModelPreset,
  onPickModelPresetPath,
  onTestLlamaCppBaseUrl,
}: ModelPresetsSectionProps) {
  const [runtimeStatus, setRuntimeStatus] = React.useState<InferenceRuntimeStatus | null>(null);
  const [openGroups, setOpenGroups] = React.useState<Record<ModelPresetGroupId, boolean>>({
    'identity-launch': true,
    'memory-compute': false,
    sampling: false,
    reasoning: false,
    speculative: false,
    lifecycle: false,
  });
  React.useEffect(() => {
    let mounted = true;
    void getInferenceRuntimeStatus()
      .then((status) => { if (mounted) setRuntimeStatus(status); })
      .catch(() => { if (mounted) setRuntimeStatus(null); });
    return () => { mounted = false; };
  }, [dashboardConfig?.Server.ModelPresets.ActivePresetId]);
  if (!dashboardConfig || !selectedModelPreset) {
    return null;
  }
  const preset = selectedModelPreset;
  const reasoningEnabled = preset.Reasoning === 'on';
  const reasoningContentEnabled = reasoningEnabled && preset.ReasoningContent;
  const baseUrl = preset.BaseUrl || '';
  const remoteLlamaBaseUrl = preset.Backend === 'llama' && isRemoteLlamaBaseUrl(baseUrl);
  const speculativeType = preset.SpeculativeType;
  const speculativeTypeOptions = preset.Backend === 'exl3' ? EXL3_SPECULATIVE_TYPE_OPTIONS : SPECULATIVE_TYPE_OPTIONS;
  const speculativeEnabled = preset.SpeculativeEnabled;
  const draftSpeculativeType = speculativeEnabled && isDraftSpeculativeType(speculativeType);
  const ngramModSpeculativeType = speculativeEnabled && speculativeType === 'ngram-mod';
  const ngramSizeSpeculativeType = speculativeEnabled && NGRAM_SIZE_SPECULATIVE_TYPES.has(speculativeType);
  const mtpCombineAvailable = speculativeEnabled && isNgramSpeculativeType(speculativeType);
  const mtpCombineEnabled = mtpCombineAvailable && preset.SpeculativeMtpEnabled;
  const draftTokenFields = draftSpeculativeType || mtpCombineEnabled;
  const mtpParallelSlotsWarning = preset.Backend === 'llama'
    && speculativeEnabled
    && (speculativeType === 'draft-mtp' || mtpCombineEnabled)
    && preset.ParallelSlots > 1;

  function toggleGroup(id: ModelPresetGroupId, next: boolean): void {
    setOpenGroups((previous) => ({ ...previous, [id]: next }));
  }

  function setBackend(backend: 'llama' | 'exl3'): void {
    updateModelPresetDraft((next) => {
      next.Backend = backend;
      if (backend === 'exl3') {
        next.SpeculativeType = 'draft-mtp';
        next.SpeculativeMtpEnabled = false;
      }
    });
  }

  const group = (id: ModelPresetGroupId, children: ReactNode): ReactNode => (
    <ModelPresetGroup id={id} open={openGroups[id]} summary={summarizeModelPresetGroup(id, preset)} onToggle={toggleGroup}>
      {children}
    </ModelPresetGroup>
  );

  return (
    <div id="mp-body" className={preset.Backend === 'exl3' ? 'exl3' : undefined}>
      <div className="mp-toolbar">
        <div className="mp-select">
          Preset
          <select
            aria-label="Model preset"
            value={dashboardConfig.Server.ModelPresets.ActivePresetId}
            onChange={(event) => updateSettingsDraft((next) => { applyModelPresetSelection(next, event.target.value); })}
            disabled={dashboardConfig.Server.ModelPresets.Presets.length === 0}
          >
            {dashboardConfig.Server.ModelPresets.Presets.map((entry) => (
              <option key={entry.id} value={entry.id}>{entry.label}</option>
            ))}
          </select>
          <span className="active-pill">active</span>
        </div>
        <button type="button" className="ghost-btn" onClick={onAddModelPreset}>Add</button>
        <button
          type="button"
          className="ghost-btn"
          onClick={() => { onDeleteModelPreset(preset.id); }}
          disabled={dashboardConfig.Server.ModelPresets.Presets.length <= 1}
        >
          Delete
        </button>
        <span style={{ flex: 1 }} />
        <div className="segc" aria-label="Preset backend">
          <button type="button" className={preset.Backend === 'llama' ? 'on' : ''} onClick={() => setBackend('llama')}>llama.cpp</button>
          <button type="button" className={preset.Backend === 'exl3' ? 'on' : ''} onClick={() => setBackend('exl3')}>EXL3</button>
        </div>
      </div>

      {runtimeStatus ? (
        <p className="hint" role="status">
          Runtime: {runtimeStatus.activePresetLabel} · {runtimeStatus.backend} · {runtimeStatus.processState}/{runtimeStatus.modelState}
        </p>
      ) : null}

      {group('identity-launch', (
        <>
          <SettingsSectionField sectionId="model-presets" label="Preset name">
            <input value={preset.label} onChange={(event) => updateModelPresetDraft((next) => { next.label = event.target.value; })} />
          </SettingsSectionField>
          {!preset.ExternalServerEnabled ? (
            <SettingsSectionField sectionId="model-presets" label="Executable path" className="be-l">
              {renderCompatibilityControl(preset, 'ExecutablePath', (
                <div className="settings-live-nav-control">
                  <input
                    value={preset.ExecutablePath || ''}
                    onChange={(event) => updateModelPresetDraft((next) => { const value = event.target.value.trim(); next.ExecutablePath = value || null; })}
                  />
                  <button type="button" onClick={() => { void onPickModelPresetPath('ExecutablePath'); }} disabled={settingsActionBusy}>
                    {settingsPathPickerBusyTarget === 'ExecutablePath' ? 'Opening…' : 'Browse…'}
                  </button>
                </div>
              ))}
            </SettingsSectionField>
          ) : null}
          {!preset.ExternalServerEnabled ? (
            <SettingsSectionField
              sectionId="model-presets"
              label={preset.Backend === 'exl3' ? 'Model directory (EXL3)' : 'Model path (.gguf)'}
            >
              <div className="settings-live-nav-control">
                <input
                  value={preset.ModelPath || ''}
                  onChange={(event) => updateModelPresetDraft((next) => {
                    const value = event.target.value.trim();
                    next.ModelPath = value || null;
                    next.Model = deriveRuntimeModelId(next.ModelPath) || next.Model;
                  })}
                />
                <button type="button" onClick={() => { void onPickModelPresetPath('ModelPath'); }} disabled={settingsActionBusy}>
                  {settingsPathPickerBusyTarget === 'ModelPath' ? 'Opening…' : 'Browse…'}
                </button>
              </div>
            </SettingsSectionField>
          ) : null}
          <SettingsSectionField sectionId="model-presets" label="External inference server">
            <label className="settings-live-toggle-control">
              <input type="checkbox" checked={preset.ExternalServerEnabled} onChange={(event) => updateModelPresetDraft((next) => { next.ExternalServerEnabled = event.target.checked; })} />
              <span>{preset.ExternalServerEnabled ? 'Enabled' : 'Disabled'}</span>
            </label>
          </SettingsSectionField>
          <SettingsSectionField sectionId="model-presets" label="Base URL" className={remoteLlamaBaseUrl ? 'settings-live-field-danger' : undefined}>
            <div className="settings-live-stack">
              <div className="settings-live-nav-control">
                <input value={baseUrl} onChange={(event) => updateModelPresetDraft((next) => { next.BaseUrl = event.target.value || null; })} />
                <button type="button" disabled={settingsActionBusy} onClick={() => { void onTestLlamaCppBaseUrl(baseUrl, preset.HealthcheckTimeoutMs); }}>Test</button>
              </div>
              {remoteLlamaBaseUrl ? (
                <div className="settings-live-warning" role="alert">
                  Remote llama.cpp URL detected. If this llama server is on another machine, the backend URL also needs to use a non-local host.
                </div>
              ) : null}
            </div>
          </SettingsSectionField>
          <SettingsSectionField sectionId="model-presets" label="Bind host">
            {renderCompatibilityControl(preset, 'BindHost', (
              <input value={preset.BindHost} onChange={(event) => updateModelPresetDraft((next) => { next.BindHost = event.target.value; })} />
            ))}
          </SettingsSectionField>
          <SettingsSectionField sectionId="model-presets" label="Port">
            {renderCompatibilityControl(preset, 'Port', (
              <input type="number" value={preset.Port} onChange={(event) => updateModelPresetDraft((next) => { next.Port = parseIntegerInput(event.target.value, next.Port); })} />
            ))}
          </SettingsSectionField>
        </>
      ))}

      {group('memory-compute', (
        <>
          <SettingsSectionField sectionId="model-presets" label="NumCtx">
            <input type="number" value={preset.NumCtx} onChange={(event) => updateModelPresetDraft((next) => { next.NumCtx = parseIntegerInput(event.target.value, next.NumCtx); })} />
          </SettingsSectionField>
          <SettingsSectionField sectionId="model-presets" label="GpuLayers" className="be-l">
            {renderCompatibilityControl(preset, 'GpuLayers', (
              <input type="number" value={preset.GpuLayers} onChange={(event) => updateModelPresetDraft((next) => { next.GpuLayers = parseIntegerInput(event.target.value, next.GpuLayers); })} />
            ))}
          </SettingsSectionField>
          <SettingsSectionField sectionId="model-presets" label="Threads" className="be-l">
            {renderCompatibilityControl(preset, 'Threads', (
              <input type="number" value={preset.Threads} onChange={(event) => updateModelPresetDraft((next) => { next.Threads = parseIntegerInput(event.target.value, next.Threads); })} />
            ))}
          </SettingsSectionField>
          <SettingsSectionField sectionId="model-presets" label="NcpuMoe" className="be-l">
            {renderCompatibilityControl(preset, 'NcpuMoe', (
              <input type="number" value={preset.NcpuMoe} onChange={(event) => updateModelPresetDraft((next) => { next.NcpuMoe = parseIntegerInput(event.target.value, next.NcpuMoe); })} />
            ))}
          </SettingsSectionField>
          <SettingsSectionField sectionId="model-presets" label="Flash attention" className="be-l">
            {renderCompatibilityControl(preset, 'FlashAttention', (
              <label className="settings-live-toggle-control">
                <input type="checkbox" checked={preset.FlashAttention} onChange={(event) => updateModelPresetDraft((next) => { next.FlashAttention = event.target.checked; })} />
                <span>{preset.FlashAttention ? 'Enabled' : 'Disabled'}</span>
              </label>
            ))}
          </SettingsSectionField>
          <SettingsSectionField sectionId="model-presets" label="ParallelSlots">
            {renderCompatibilityControl(preset, 'ParallelSlots', (
              <input type="number" value={preset.ParallelSlots} onChange={(event) => updateModelPresetDraft((next) => { next.ParallelSlots = parseIntegerInput(event.target.value, next.ParallelSlots); })} />
            ))}
          </SettingsSectionField>
          <SettingsSectionField sectionId="model-presets" label="BatchSize" className="be-l">
            {renderCompatibilityControl(preset, 'BatchSize', (
              <input type="number" value={preset.BatchSize} onChange={(event) => updateModelPresetDraft((next) => { next.BatchSize = parseIntegerInput(event.target.value, next.BatchSize); })} />
            ))}
          </SettingsSectionField>
          <SettingsSectionField sectionId="model-presets" label="UBatchSize">
            {renderCompatibilityControl(preset, 'UBatchSize', (
              <input type="number" value={preset.UBatchSize} onChange={(event) => updateModelPresetDraft((next) => { next.UBatchSize = parseIntegerInput(event.target.value, next.UBatchSize); })} />
            ))}
          </SettingsSectionField>
          <SettingsSectionField sectionId="model-presets" label="CacheRam" className="be-l">
            {renderCompatibilityControl(preset, 'CacheRam', (
              <input type="number" value={preset.CacheRam} onChange={(event) => updateModelPresetDraft((next) => { next.CacheRam = parseIntegerInput(event.target.value, next.CacheRam); })} />
            ))}
          </SettingsSectionField>
          <SettingsSectionField sectionId="model-presets" label="KV cache quant">
            {renderCompatibilityControl(preset, 'KvCacheQuantization', (
              <select value={preset.KvCacheQuantization} onChange={(event) => updateModelPresetDraft((next) => { const value = KV_CACHE_QUANT_OPTIONS.find((option) => option === event.target.value); if (value) next.KvCacheQuantization = value; })}>
                {KV_CACHE_QUANT_OPTIONS.map((option) => (
                  <option key={option} value={option} disabled={preset.Backend === 'exl3' && getExl3CacheMode(option) === null}>{option}</option>
                ))}
              </select>
            ))}
          </SettingsSectionField>
        </>
      ))}

      {group('sampling', (
        <>
          <SettingsSectionField sectionId="model-presets" label="MaxTokens">
            <input type="number" value={preset.MaxTokens} onChange={(event) => updateModelPresetDraft((next) => { next.MaxTokens = parseIntegerInput(event.target.value, next.MaxTokens); })} />
          </SettingsSectionField>
          <SettingsSectionField sectionId="model-presets" label="Temperature">
            <input type="number" step="0.01" value={preset.Temperature} onChange={(event) => updateModelPresetDraft((next) => { next.Temperature = parseFloatInput(event.target.value, next.Temperature); })} />
          </SettingsSectionField>
          <SettingsSectionField sectionId="model-presets" label="TopP">
            <input type="number" step="0.01" value={preset.TopP} onChange={(event) => updateModelPresetDraft((next) => { next.TopP = parseFloatInput(event.target.value, next.TopP); })} />
          </SettingsSectionField>
          <SettingsSectionField sectionId="model-presets" label="TopK">
            <input type="number" value={preset.TopK} onChange={(event) => updateModelPresetDraft((next) => { next.TopK = parseIntegerInput(event.target.value, next.TopK); })} />
          </SettingsSectionField>
          <SettingsSectionField sectionId="model-presets" label="MinP">
            <input type="number" step="0.01" value={preset.MinP} onChange={(event) => updateModelPresetDraft((next) => { next.MinP = parseFloatInput(event.target.value, next.MinP); })} />
          </SettingsSectionField>
          <SettingsSectionField sectionId="model-presets" label="PresencePenalty">
            <input type="number" step="0.01" value={preset.PresencePenalty} onChange={(event) => updateModelPresetDraft((next) => { next.PresencePenalty = parseFloatInput(event.target.value, next.PresencePenalty); })} />
          </SettingsSectionField>
          <SettingsSectionField sectionId="model-presets" label="RepetitionPenalty">
            <input type="number" step="0.01" value={preset.RepetitionPenalty} onChange={(event) => updateModelPresetDraft((next) => { next.RepetitionPenalty = parseFloatInput(event.target.value, next.RepetitionPenalty); })} />
          </SettingsSectionField>
        </>
      ))}

      {group('reasoning', (
        <>
          <SettingsSectionField sectionId="model-presets" label="Reasoning">
            <select
              value={preset.Reasoning}
              onChange={(event) => updateModelPresetDraft((next) => {
                next.Reasoning = event.target.value === 'on' ? 'on' : 'off';
                if (next.Reasoning !== 'on') {
                  next.ReasoningContent = false;
                  next.PreserveThinking = false;
                  next.MaintainPerStepThinking = false;
                } else {
                  next.MaintainPerStepThinking = true;
                }
              })}
            >
              <option value="off">off</option>
              <option value="on">on</option>
            </select>
          </SettingsSectionField>
          {reasoningEnabled ? (
            <SettingsSectionField sectionId="model-presets" label="Reasoning content">
              <label className="settings-live-toggle-control">
                <input
                  type="checkbox"
                  checked={preset.ReasoningContent}
                  onChange={(event) => updateModelPresetDraft((next) => { next.ReasoningContent = event.target.checked; if (!next.ReasoningContent) { next.PreserveThinking = false; } })}
                />
                <span>{preset.ReasoningContent ? 'Enabled' : 'Disabled'}</span>
              </label>
            </SettingsSectionField>
          ) : null}
          {reasoningContentEnabled ? (
            <SettingsSectionField sectionId="model-presets" label="Preserve thinking">
              <label className="settings-live-toggle-control">
                <input type="checkbox" checked={preset.PreserveThinking} onChange={(event) => updateModelPresetDraft((next) => { next.PreserveThinking = event.target.checked; })} />
                <span>{preset.PreserveThinking ? 'Enabled' : 'Disabled'}</span>
              </label>
            </SettingsSectionField>
          ) : null}
          {reasoningEnabled ? (
            <SettingsSectionField sectionId="model-presets" label="Maintain per step thinking">
              <label className="settings-live-toggle-control">
                <input type="checkbox" checked={preset.MaintainPerStepThinking} onChange={(event) => updateModelPresetDraft((next) => { next.MaintainPerStepThinking = event.target.checked; })} />
                <span>{preset.MaintainPerStepThinking ? 'Enabled' : 'Disabled'}</span>
              </label>
            </SettingsSectionField>
          ) : null}
          <SettingsSectionField sectionId="model-presets" label="ReasoningBudget">
            {renderCompatibilityControl(preset, 'ReasoningBudget', (
              <input type="number" value={preset.ReasoningBudget} onChange={(event) => updateModelPresetDraft((next) => { next.ReasoningBudget = parseIntegerInput(event.target.value, next.ReasoningBudget); })} />
            ))}
          </SettingsSectionField>
          <SettingsSectionField sectionId="model-presets" label="ReasoningBudgetMessage" className="w4">
            {renderCompatibilityControl(preset, 'ReasoningBudgetMessage', (
              <textarea rows={3} value={preset.ReasoningBudgetMessage || ''} onChange={(event) => updateModelPresetDraft((next) => { next.ReasoningBudgetMessage = event.target.value || null; })} />
            ))}
          </SettingsSectionField>
        </>
      ))}

      {group('speculative', (
        <>
          <SettingsSectionField sectionId="model-presets" label="Enable speculative decoding">
            {renderCompatibilityControl(preset, 'SpeculativeEnabled', (
              <label className="settings-live-toggle-control">
                <input type="checkbox" checked={preset.SpeculativeEnabled} onChange={(event) => updateModelPresetDraft((next) => { next.SpeculativeEnabled = event.target.checked; })} />
                <span>{preset.SpeculativeEnabled ? 'Enabled' : 'Disabled'}</span>
              </label>
            ))}
          </SettingsSectionField>
          {speculativeEnabled ? (
            <SettingsSectionField sectionId="model-presets" label="Speculative type">
              {renderCompatibilityControl(preset, 'SpeculativeType', (
                <select value={preset.SpeculativeType} onChange={(event) => updateModelPresetDraft((next) => { const value = SPECULATIVE_TYPE_OPTIONS.find((option) => option === event.target.value); if (value) next.SpeculativeType = value; })}>
                  {speculativeTypeOptions.map((option) => <option key={option} value={option}>{option}</option>)}
                </select>
              ))}
            </SettingsSectionField>
          ) : null}
          {mtpCombineAvailable ? (
            <SettingsSectionField sectionId="model-presets" label="Combine with MTP">
              {renderCompatibilityControl(preset, 'SpeculativeMtpEnabled', (
                <label className="settings-live-toggle-control">
                  <input type="checkbox" checked={preset.SpeculativeMtpEnabled} onChange={(event) => updateModelPresetDraft((next) => { next.SpeculativeMtpEnabled = event.target.checked; })} />
                  <span>{preset.SpeculativeMtpEnabled ? 'Enabled' : 'Disabled'}</span>
                </label>
              ))}
            </SettingsSectionField>
          ) : null}
          {mtpParallelSlotsWarning ? (
            <div className="field w4"><div className="settings-live-warning cond-note" role="alert">MTP speculative decoding does not support parallel slots above 1 in the upstream llama.cpp implementation.</div></div>
          ) : null}
          {ngramSizeSpeculativeType ? (
            <SettingsSectionField sectionId="model-presets" label="SpeculativeNgramSizeN" className="be-l">
              {renderCompatibilityControl(preset, 'SpeculativeNgramSizeN', (
                <input type="number" value={preset.SpeculativeNgramSizeN} onChange={(event) => updateModelPresetDraft((next) => { next.SpeculativeNgramSizeN = parseIntegerInput(event.target.value, next.SpeculativeNgramSizeN); })} />
              ))}
            </SettingsSectionField>
          ) : null}
          {ngramSizeSpeculativeType ? (
            <SettingsSectionField sectionId="model-presets" label="SpeculativeNgramSizeM" className="be-l">
              {renderCompatibilityControl(preset, 'SpeculativeNgramSizeM', (
                <input type="number" value={preset.SpeculativeNgramSizeM} onChange={(event) => updateModelPresetDraft((next) => { next.SpeculativeNgramSizeM = parseIntegerInput(event.target.value, next.SpeculativeNgramSizeM); })} />
              ))}
            </SettingsSectionField>
          ) : null}
          {ngramSizeSpeculativeType ? (
            <SettingsSectionField sectionId="model-presets" label="SpeculativeNgramMinHits" className="be-l">
              {renderCompatibilityControl(preset, 'SpeculativeNgramMinHits', (
                <input type="number" value={preset.SpeculativeNgramMinHits} onChange={(event) => updateModelPresetDraft((next) => { next.SpeculativeNgramMinHits = parseIntegerInput(event.target.value, next.SpeculativeNgramMinHits); })} />
              ))}
            </SettingsSectionField>
          ) : null}
          {ngramModSpeculativeType ? (
            <SettingsSectionField sectionId="model-presets" label="SpeculativeNgramModNMatch" className="be-l">
              {renderCompatibilityControl(preset, 'SpeculativeNgramModNMatch', (
                <input type="number" value={preset.SpeculativeNgramModNMatch} onChange={(event) => updateModelPresetDraft((next) => { next.SpeculativeNgramModNMatch = parseIntegerInput(event.target.value, next.SpeculativeNgramModNMatch); })} />
              ))}
            </SettingsSectionField>
          ) : null}
          {ngramModSpeculativeType ? (
            <SettingsSectionField sectionId="model-presets" label="SpeculativeNgramModNMin" className="be-l">
              {renderCompatibilityControl(preset, 'SpeculativeNgramModNMin', (
                <input type="number" value={preset.SpeculativeNgramModNMin} onChange={(event) => updateModelPresetDraft((next) => { next.SpeculativeNgramModNMin = parseIntegerInput(event.target.value, next.SpeculativeNgramModNMin); })} />
              ))}
            </SettingsSectionField>
          ) : null}
          {ngramModSpeculativeType ? (
            <SettingsSectionField sectionId="model-presets" label="SpeculativeNgramModNMax" className="be-l">
              {renderCompatibilityControl(preset, 'SpeculativeNgramModNMax', (
                <input type="number" value={preset.SpeculativeNgramModNMax} onChange={(event) => updateModelPresetDraft((next) => { next.SpeculativeNgramModNMax = parseIntegerInput(event.target.value, next.SpeculativeNgramModNMax); })} />
              ))}
            </SettingsSectionField>
          ) : null}
          {draftTokenFields ? (
            <SettingsSectionField sectionId="model-presets" label="SpeculativeDraftMax">
              {renderCompatibilityControl(preset, 'SpeculativeDraftMax', (
                <input type="number" value={preset.SpeculativeDraftMax} onChange={(event) => updateModelPresetDraft((next) => { next.SpeculativeDraftMax = parseIntegerInput(event.target.value, next.SpeculativeDraftMax); })} />
              ))}
            </SettingsSectionField>
          ) : null}
          {draftTokenFields ? (
            <SettingsSectionField sectionId="model-presets" label="SpeculativeDraftMin">
              {renderCompatibilityControl(preset, 'SpeculativeDraftMin', (
                <input type="number" value={preset.SpeculativeDraftMin} onChange={(event) => updateModelPresetDraft((next) => { next.SpeculativeDraftMin = parseIntegerInput(event.target.value, next.SpeculativeDraftMin); })} />
              ))}
            </SettingsSectionField>
          ) : null}
        </>
      ))}

      {group('lifecycle', (
        <>
          <SettingsSectionField sectionId="model-presets" label="StartupTimeoutMs">
            <input type="number" value={preset.StartupTimeoutMs} onChange={(event) => updateModelPresetDraft((next) => { next.StartupTimeoutMs = parseIntegerInput(event.target.value, next.StartupTimeoutMs); })} />
          </SettingsSectionField>
          <SettingsSectionField sectionId="model-presets" label="HealthcheckTimeoutMs">
            <input type="number" value={preset.HealthcheckTimeoutMs} onChange={(event) => updateModelPresetDraft((next) => { next.HealthcheckTimeoutMs = parseIntegerInput(event.target.value, next.HealthcheckTimeoutMs); })} />
          </SettingsSectionField>
          <SettingsSectionField sectionId="model-presets" label="HealthcheckIntervalMs">
            <input type="number" value={preset.HealthcheckIntervalMs} onChange={(event) => updateModelPresetDraft((next) => { next.HealthcheckIntervalMs = parseIntegerInput(event.target.value, next.HealthcheckIntervalMs); })} />
          </SettingsSectionField>
          <SettingsSectionField sectionId="model-presets" label="SleepIdleSeconds">
            <input type="number" value={preset.SleepIdleSeconds} onChange={(event) => updateModelPresetDraft((next) => { next.SleepIdleSeconds = parseIntegerInput(event.target.value, next.SleepIdleSeconds); })} />
          </SettingsSectionField>
          <SettingsSectionField sectionId="model-presets" label="Verbose logging">
            {renderCompatibilityControl(preset, 'VerboseLogging', (
              <label className="settings-live-toggle-control">
                <input type="checkbox" checked={preset.VerboseLogging} onChange={(event) => updateModelPresetDraft((next) => { next.VerboseLogging = event.target.checked; })} />
                <span>{preset.VerboseLogging ? 'Enabled' : 'Disabled'}</span>
              </label>
            ))}
          </SettingsSectionField>
        </>
      ))}
      <div className="cond-note">Runtime changes take effect on Save settings → backend restart.</div>
    </div>
  );
}

import React from 'react';
import type { ReactNode } from 'react';

import { parseFloatInput, parseIntegerInput } from '../../lib/format';
import { getExl3CacheModes, getPresetFieldAvailability } from '../../../../src/inference-presets/preset-compatibility.js';
import { getInferenceRuntimeStatus } from '../../api';
import { summarizeModelPresetGroup, type ModelPresetGroupId } from './model-preset-groups';
import { SettingsSectionField } from '../../settings/SettingsFields';
import type { InferenceRuntimeStatus } from '@siftkit/contracts';
import type {
  DashboardConfig,
  DashboardModelRuntimePreset,
  DashboardManagedLlamaSpeculativeType,
  ModelPresetField,
} from '../../types';
import type { ModelPresetSettingsActions } from '../../settings-action-groups';
import {
  isModelPresetPickerBusy,
  type SettingsPathPickerBusyTarget,
} from '../../settings-flow';

const KV_CACHE_QUANT_OPTIONS = ['f32', 'f16', 'bf16', 'q8_0', 'q4_0', 'q4_1', 'iq4_nl', 'q5_0', 'q5_1', 'q8_0/q4_0', 'q8_0/q5_0'] as const;
const SPECULATIVE_TYPE_OPTIONS = ['draft-simple', 'draft-eagle3', 'draft-mtp', 'ngram-simple', 'ngram-map-k', 'ngram-map-k4v', 'ngram-mod', 'ngram-cache'] as const;
const EXL3_SPECULATIVE_TYPE_OPTIONS = ['draft-mtp'] as const;
const LOCAL_LLAMA_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]', '0.0.0.0']);

type ModelPresetsSectionProps = {
  dashboardConfig: DashboardConfig | null;
  selectedModelPreset: DashboardModelRuntimePreset | null;
  settingsActionBusy: boolean;
  settingsPathPickerBusyTarget: SettingsPathPickerBusyTarget | null;
  modelPresetActions: ModelPresetSettingsActions;
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
  modelPresetActions,
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
            onChange={(event) => modelPresetActions.selectPreset(event.target.value)}
            disabled={dashboardConfig.Server.ModelPresets.Presets.length === 0}
          >
            {dashboardConfig.Server.ModelPresets.Presets.map((entry) => (
              <option key={entry.id} value={entry.id}>{entry.label}</option>
            ))}
          </select>
          <span className="active-pill">active</span>
        </div>
        <button type="button" className="ghost-btn" onClick={modelPresetActions.addPreset}>Add</button>
        <button
          type="button"
          className="ghost-btn"
          onClick={() => modelPresetActions.deletePreset(preset.id)}
          disabled={dashboardConfig.Server.ModelPresets.Presets.length <= 1}
        >
          Delete
        </button>
        <span style={{ flex: 1 }} />
        <div className="segc" aria-label="Preset backend">
          <button type="button" className={preset.Backend === 'llama' ? 'on' : ''} onClick={() => modelPresetActions.setBackend('llama')}>llama.cpp</button>
          <button type="button" className={preset.Backend === 'exl3' ? 'on' : ''} onClick={() => modelPresetActions.setBackend('exl3')}>EXL3</button>
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
            <input value={preset.label} onChange={(event) => modelPresetActions.setString('label', event.target.value)} />
          </SettingsSectionField>
          {!preset.ExternalServerEnabled ? (
            <SettingsSectionField sectionId="model-presets" label="Executable path" className="be-l">
              {renderCompatibilityControl(preset, 'ExecutablePath', (
                <div className="settings-live-nav-control">
                  <input
                    value={preset.ExecutablePath || ''}
                    onChange={(event) => modelPresetActions.setNullableString('ExecutablePath', event.target.value.trim() || null)}
                  />
                  <button type="button" onClick={() => { void modelPresetActions.pickPath('ExecutablePath'); }} disabled={settingsActionBusy}>
                    {isModelPresetPickerBusy(settingsPathPickerBusyTarget, 'ExecutablePath') ? 'Opening…' : 'Browse…'}
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
                  onChange={(event) => modelPresetActions.setModelPath(event.target.value.trim() || null)}
                />
                <button type="button" onClick={() => { void modelPresetActions.pickPath('ModelPath'); }} disabled={settingsActionBusy}>
                  {isModelPresetPickerBusy(settingsPathPickerBusyTarget, 'ModelPath') ? 'Opening…' : 'Browse…'}
                </button>
              </div>
            </SettingsSectionField>
          ) : null}
          <SettingsSectionField sectionId="model-presets" label="External inference server">
            <label className="settings-live-toggle-control">
              <input type="checkbox" checked={preset.ExternalServerEnabled} onChange={(event) => modelPresetActions.setBoolean('ExternalServerEnabled', event.target.checked)} />
              <span>{preset.ExternalServerEnabled ? 'Enabled' : 'Disabled'}</span>
            </label>
          </SettingsSectionField>
          <SettingsSectionField sectionId="model-presets" label="Base URL" className={remoteLlamaBaseUrl ? 'settings-live-field-danger' : undefined}>
            <div className="settings-live-stack">
              <div className="settings-live-nav-control">
                <input value={baseUrl} onChange={(event) => modelPresetActions.setNullableString('BaseUrl', event.target.value || null)} />
                <button type="button" disabled={settingsActionBusy} onClick={() => { void modelPresetActions.testBaseUrl(baseUrl, preset.HealthcheckTimeoutMs); }}>Test</button>
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
              <input value={preset.BindHost} onChange={(event) => modelPresetActions.setString('BindHost', event.target.value)} />
            ))}
          </SettingsSectionField>
          <SettingsSectionField sectionId="model-presets" label="Port">
            {renderCompatibilityControl(preset, 'Port', (
              <input type="number" value={preset.Port} onChange={(event) => modelPresetActions.setInteger('Port', parseIntegerInput(event.target.value, preset.Port))} />
            ))}
          </SettingsSectionField>
        </>
      ))}

      {group('memory-compute', (
        <>
          <SettingsSectionField sectionId="model-presets" label="NumCtx">
            <input type="number" value={preset.NumCtx} onChange={(event) => modelPresetActions.setInteger('NumCtx', parseIntegerInput(event.target.value, preset.NumCtx))} />
          </SettingsSectionField>
          <SettingsSectionField sectionId="model-presets" label="GpuLayers" className="be-l">
            {renderCompatibilityControl(preset, 'GpuLayers', (
              <input type="number" value={preset.GpuLayers} onChange={(event) => modelPresetActions.setInteger('GpuLayers', parseIntegerInput(event.target.value, preset.GpuLayers))} />
            ))}
          </SettingsSectionField>
          <SettingsSectionField sectionId="model-presets" label="Threads" className="be-l">
            {renderCompatibilityControl(preset, 'Threads', (
              <input type="number" value={preset.Threads} onChange={(event) => modelPresetActions.setInteger('Threads', parseIntegerInput(event.target.value, preset.Threads))} />
            ))}
          </SettingsSectionField>
          <SettingsSectionField sectionId="model-presets" label="NcpuMoe" className="be-l">
            {renderCompatibilityControl(preset, 'NcpuMoe', (
              <input type="number" value={preset.NcpuMoe} onChange={(event) => modelPresetActions.setInteger('NcpuMoe', parseIntegerInput(event.target.value, preset.NcpuMoe))} />
            ))}
          </SettingsSectionField>
          <SettingsSectionField sectionId="model-presets" label="Flash attention" className="be-l">
            {renderCompatibilityControl(preset, 'FlashAttention', (
              <label className="settings-live-toggle-control">
                <input type="checkbox" checked={preset.FlashAttention} onChange={(event) => modelPresetActions.setBoolean('FlashAttention', event.target.checked)} />
                <span>{preset.FlashAttention ? 'Enabled' : 'Disabled'}</span>
              </label>
            ))}
          </SettingsSectionField>
          <SettingsSectionField sectionId="model-presets" label="ParallelSlots">
            {renderCompatibilityControl(preset, 'ParallelSlots', (
              <input type="number" value={preset.ParallelSlots} onChange={(event) => modelPresetActions.setInteger('ParallelSlots', parseIntegerInput(event.target.value, preset.ParallelSlots))} />
            ))}
          </SettingsSectionField>
          <SettingsSectionField sectionId="model-presets" label="BatchSize" className="be-l">
            {renderCompatibilityControl(preset, 'BatchSize', (
              <input type="number" value={preset.BatchSize} onChange={(event) => modelPresetActions.setInteger('BatchSize', parseIntegerInput(event.target.value, preset.BatchSize))} />
            ))}
          </SettingsSectionField>
          <SettingsSectionField sectionId="model-presets" label="UBatchSize">
            {renderCompatibilityControl(preset, 'UBatchSize', (
              <input type="number" value={preset.UBatchSize} onChange={(event) => modelPresetActions.setInteger('UBatchSize', parseIntegerInput(event.target.value, preset.UBatchSize))} />
            ))}
          </SettingsSectionField>
          <SettingsSectionField sectionId="model-presets" label="CacheRam" className="be-l">
            {renderCompatibilityControl(preset, 'CacheRam', (
              <input type="number" value={preset.CacheRam} onChange={(event) => modelPresetActions.setInteger('CacheRam', parseIntegerInput(event.target.value, preset.CacheRam))} />
            ))}
          </SettingsSectionField>
          <SettingsSectionField sectionId="model-presets" label="KV cache quant">
            {renderCompatibilityControl(preset, 'KvCacheQuantization', (
              <select value={preset.KvCacheQuantization} onChange={(event) => {
                const value = KV_CACHE_QUANT_OPTIONS.find((option) => option === event.target.value);
                if (value) modelPresetActions.setKvCacheQuantization(value);
              }}>
                {KV_CACHE_QUANT_OPTIONS.map((option) => (
                  <option key={option} value={option} disabled={preset.Backend === 'exl3' && getExl3CacheModes(option) === null}>{option}</option>
                ))}
              </select>
            ))}
          </SettingsSectionField>
        </>
      ))}

      {group('sampling', (
        <>
          <SettingsSectionField sectionId="model-presets" label="MaxTokens">
            <input type="number" value={preset.MaxTokens} onChange={(event) => modelPresetActions.setInteger('MaxTokens', parseIntegerInput(event.target.value, preset.MaxTokens))} />
          </SettingsSectionField>
          <SettingsSectionField sectionId="model-presets" label="Temperature">
            <input type="number" step="0.01" value={preset.Temperature} onChange={(event) => modelPresetActions.setFloat('Temperature', parseFloatInput(event.target.value, preset.Temperature))} />
          </SettingsSectionField>
          <SettingsSectionField sectionId="model-presets" label="TopP">
            <input type="number" step="0.01" value={preset.TopP} onChange={(event) => modelPresetActions.setFloat('TopP', parseFloatInput(event.target.value, preset.TopP))} />
          </SettingsSectionField>
          <SettingsSectionField sectionId="model-presets" label="TopK">
            <input type="number" value={preset.TopK} onChange={(event) => modelPresetActions.setInteger('TopK', parseIntegerInput(event.target.value, preset.TopK))} />
          </SettingsSectionField>
          <SettingsSectionField sectionId="model-presets" label="MinP">
            <input type="number" step="0.01" value={preset.MinP} onChange={(event) => modelPresetActions.setFloat('MinP', parseFloatInput(event.target.value, preset.MinP))} />
          </SettingsSectionField>
          <SettingsSectionField sectionId="model-presets" label="PresencePenalty">
            <input type="number" step="0.01" value={preset.PresencePenalty} onChange={(event) => modelPresetActions.setFloat('PresencePenalty', parseFloatInput(event.target.value, preset.PresencePenalty))} />
          </SettingsSectionField>
          <SettingsSectionField sectionId="model-presets" label="RepetitionPenalty">
            <input type="number" step="0.01" value={preset.RepetitionPenalty} onChange={(event) => modelPresetActions.setFloat('RepetitionPenalty', parseFloatInput(event.target.value, preset.RepetitionPenalty))} />
          </SettingsSectionField>
        </>
      ))}

      {group('reasoning', (
        <>
          <SettingsSectionField sectionId="model-presets" label="Reasoning">
            <select
              value={preset.Reasoning}
              onChange={(event) => modelPresetActions.setReasoning(event.target.value === 'on' ? 'on' : 'off')}
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
                  onChange={(event) => modelPresetActions.setReasoningContent(event.target.checked)}
                />
                <span>{preset.ReasoningContent ? 'Enabled' : 'Disabled'}</span>
              </label>
            </SettingsSectionField>
          ) : null}
          {reasoningContentEnabled ? (
            <SettingsSectionField sectionId="model-presets" label="Preserve thinking">
              <label className="settings-live-toggle-control">
                <input type="checkbox" checked={preset.PreserveThinking} onChange={(event) => modelPresetActions.setBoolean('PreserveThinking', event.target.checked)} />
                <span>{preset.PreserveThinking ? 'Enabled' : 'Disabled'}</span>
              </label>
            </SettingsSectionField>
          ) : null}
          {reasoningEnabled ? (
            <SettingsSectionField sectionId="model-presets" label="Maintain per step thinking">
              <label className="settings-live-toggle-control">
                <input type="checkbox" checked={preset.MaintainPerStepThinking} onChange={(event) => modelPresetActions.setBoolean('MaintainPerStepThinking', event.target.checked)} />
                <span>{preset.MaintainPerStepThinking ? 'Enabled' : 'Disabled'}</span>
              </label>
            </SettingsSectionField>
          ) : null}
          <SettingsSectionField sectionId="model-presets" label="ReasoningBudget">
            {renderCompatibilityControl(preset, 'ReasoningBudget', (
              <input type="number" value={preset.ReasoningBudget} onChange={(event) => modelPresetActions.setInteger('ReasoningBudget', parseIntegerInput(event.target.value, preset.ReasoningBudget))} />
            ))}
          </SettingsSectionField>
          <SettingsSectionField sectionId="model-presets" label="ReasoningBudgetMessage" className="w4">
            {renderCompatibilityControl(preset, 'ReasoningBudgetMessage', (
              <textarea rows={3} value={preset.ReasoningBudgetMessage || ''} onChange={(event) => modelPresetActions.setNullableString('ReasoningBudgetMessage', event.target.value || null)} />
            ))}
          </SettingsSectionField>
        </>
      ))}

      {group('speculative', (
        <>
          <SettingsSectionField sectionId="model-presets" label="Enable speculative decoding">
            {renderCompatibilityControl(preset, 'SpeculativeEnabled', (
              <label className="settings-live-toggle-control">
                <input type="checkbox" checked={preset.SpeculativeEnabled} onChange={(event) => modelPresetActions.setBoolean('SpeculativeEnabled', event.target.checked)} />
                <span>{preset.SpeculativeEnabled ? 'Enabled' : 'Disabled'}</span>
              </label>
            ))}
          </SettingsSectionField>
          {speculativeEnabled ? (
            <SettingsSectionField sectionId="model-presets" label="Speculative type">
              {renderCompatibilityControl(preset, 'SpeculativeType', (
                <select value={preset.SpeculativeType} onChange={(event) => {
                  const value = SPECULATIVE_TYPE_OPTIONS.find((option) => option === event.target.value);
                  if (value) modelPresetActions.setSpeculativeType(value);
                }}>
                  {speculativeTypeOptions.map((option) => <option key={option} value={option}>{option}</option>)}
                </select>
              ))}
            </SettingsSectionField>
          ) : null}
          {mtpCombineAvailable ? (
            <SettingsSectionField sectionId="model-presets" label="Combine with MTP">
              {renderCompatibilityControl(preset, 'SpeculativeMtpEnabled', (
                <label className="settings-live-toggle-control">
                  <input type="checkbox" checked={preset.SpeculativeMtpEnabled} onChange={(event) => modelPresetActions.setBoolean('SpeculativeMtpEnabled', event.target.checked)} />
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
                <input type="number" value={preset.SpeculativeNgramSizeN} onChange={(event) => modelPresetActions.setInteger('SpeculativeNgramSizeN', parseIntegerInput(event.target.value, preset.SpeculativeNgramSizeN))} />
              ))}
            </SettingsSectionField>
          ) : null}
          {ngramSizeSpeculativeType ? (
            <SettingsSectionField sectionId="model-presets" label="SpeculativeNgramSizeM" className="be-l">
              {renderCompatibilityControl(preset, 'SpeculativeNgramSizeM', (
                <input type="number" value={preset.SpeculativeNgramSizeM} onChange={(event) => modelPresetActions.setInteger('SpeculativeNgramSizeM', parseIntegerInput(event.target.value, preset.SpeculativeNgramSizeM))} />
              ))}
            </SettingsSectionField>
          ) : null}
          {ngramSizeSpeculativeType ? (
            <SettingsSectionField sectionId="model-presets" label="SpeculativeNgramMinHits" className="be-l">
              {renderCompatibilityControl(preset, 'SpeculativeNgramMinHits', (
                <input type="number" value={preset.SpeculativeNgramMinHits} onChange={(event) => modelPresetActions.setInteger('SpeculativeNgramMinHits', parseIntegerInput(event.target.value, preset.SpeculativeNgramMinHits))} />
              ))}
            </SettingsSectionField>
          ) : null}
          {ngramModSpeculativeType ? (
            <SettingsSectionField sectionId="model-presets" label="SpeculativeNgramModNMatch" className="be-l">
              {renderCompatibilityControl(preset, 'SpeculativeNgramModNMatch', (
                <input type="number" value={preset.SpeculativeNgramModNMatch} onChange={(event) => modelPresetActions.setInteger('SpeculativeNgramModNMatch', parseIntegerInput(event.target.value, preset.SpeculativeNgramModNMatch))} />
              ))}
            </SettingsSectionField>
          ) : null}
          {ngramModSpeculativeType ? (
            <SettingsSectionField sectionId="model-presets" label="SpeculativeNgramModNMin" className="be-l">
              {renderCompatibilityControl(preset, 'SpeculativeNgramModNMin', (
                <input type="number" value={preset.SpeculativeNgramModNMin} onChange={(event) => modelPresetActions.setInteger('SpeculativeNgramModNMin', parseIntegerInput(event.target.value, preset.SpeculativeNgramModNMin))} />
              ))}
            </SettingsSectionField>
          ) : null}
          {ngramModSpeculativeType ? (
            <SettingsSectionField sectionId="model-presets" label="SpeculativeNgramModNMax" className="be-l">
              {renderCompatibilityControl(preset, 'SpeculativeNgramModNMax', (
                <input type="number" value={preset.SpeculativeNgramModNMax} onChange={(event) => modelPresetActions.setInteger('SpeculativeNgramModNMax', parseIntegerInput(event.target.value, preset.SpeculativeNgramModNMax))} />
              ))}
            </SettingsSectionField>
          ) : null}
          {draftTokenFields ? (
            <SettingsSectionField sectionId="model-presets" label="SpeculativeDraftMax">
              {renderCompatibilityControl(preset, 'SpeculativeDraftMax', (
                <input type="number" value={preset.SpeculativeDraftMax} onChange={(event) => modelPresetActions.setInteger('SpeculativeDraftMax', parseIntegerInput(event.target.value, preset.SpeculativeDraftMax))} />
              ))}
            </SettingsSectionField>
          ) : null}
          {draftTokenFields ? (
            <SettingsSectionField sectionId="model-presets" label="SpeculativeDraftMin">
              {renderCompatibilityControl(preset, 'SpeculativeDraftMin', (
                <input type="number" value={preset.SpeculativeDraftMin} onChange={(event) => modelPresetActions.setInteger('SpeculativeDraftMin', parseIntegerInput(event.target.value, preset.SpeculativeDraftMin))} />
              ))}
            </SettingsSectionField>
          ) : null}
        </>
      ))}

      {group('lifecycle', (
        <>
          <SettingsSectionField sectionId="model-presets" label="StartupTimeoutMs">
            <input type="number" value={preset.StartupTimeoutMs} onChange={(event) => modelPresetActions.setInteger('StartupTimeoutMs', parseIntegerInput(event.target.value, preset.StartupTimeoutMs))} />
          </SettingsSectionField>
          <SettingsSectionField sectionId="model-presets" label="HealthcheckTimeoutMs">
            <input type="number" value={preset.HealthcheckTimeoutMs} onChange={(event) => modelPresetActions.setInteger('HealthcheckTimeoutMs', parseIntegerInput(event.target.value, preset.HealthcheckTimeoutMs))} />
          </SettingsSectionField>
          <SettingsSectionField sectionId="model-presets" label="HealthcheckIntervalMs">
            <input type="number" value={preset.HealthcheckIntervalMs} onChange={(event) => modelPresetActions.setInteger('HealthcheckIntervalMs', parseIntegerInput(event.target.value, preset.HealthcheckIntervalMs))} />
          </SettingsSectionField>
          <SettingsSectionField sectionId="model-presets" label="SleepIdleSeconds">
            <input type="number" value={preset.SleepIdleSeconds} onChange={(event) => modelPresetActions.setInteger('SleepIdleSeconds', parseIntegerInput(event.target.value, preset.SleepIdleSeconds))} />
          </SettingsSectionField>
          <SettingsSectionField sectionId="model-presets" label="Verbose logging">
            {renderCompatibilityControl(preset, 'VerboseLogging', (
              <label className="settings-live-toggle-control">
                <input type="checkbox" checked={preset.VerboseLogging} onChange={(event) => modelPresetActions.setBoolean('VerboseLogging', event.target.checked)} />
                <span>{preset.VerboseLogging ? 'Enabled' : 'Disabled'}</span>
              </label>
            ))}
          </SettingsSectionField>
          <SettingsSectionField sectionId="model-presets" label="Vision enabled">
            {renderCompatibilityControl(preset, 'VisionEnabled', (
              <label className="settings-live-toggle-control">
                <input type="checkbox" checked={preset.VisionEnabled} onChange={(event) => modelPresetActions.setBoolean('VisionEnabled', event.target.checked)} />
                <span>{preset.VisionEnabled ? 'Enabled' : 'Disabled'}</span>
              </label>
            ))}
          </SettingsSectionField>
        </>
      ))}
      <div className="cond-note">Runtime changes take effect on Save settings → backend restart.</div>
    </div>
  );
}

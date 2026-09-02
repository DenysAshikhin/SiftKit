import React from 'react';
import type { ReactNode } from 'react';

import { parseFloatInput, parseIntegerInput } from '../../lib/format';
import { summarizeModelPresetGroup, type ModelPresetGroupId } from './model-preset-groups';
import { SettingsSectionField } from '../../settings/SettingsFields';
import { VisionPresetControls, ModelPresetControl } from './VisionPresetControls.js';
import { ModelIdleActionSchema, ModelKvCacheQuantizationSchema, ReasoningEffortSchema } from '@siftkit/contracts';
import type {
  DashboardConfig,
  DashboardModelRuntimePreset,
} from '../../types';
import type { InferenceRuntimeDashboardStatus } from '@siftkit/contracts';
import type { ModelPresetSettingsActions } from '../../settings-action-groups';
import {
  isModelPresetPickerBusy,
  type SettingsPathPickerBusyTarget,
} from '../../settings-flow';

type ModelPresetsSectionProps = {
  dashboardConfig: DashboardConfig | null;
  selectedModelPreset: DashboardModelRuntimePreset | null;
  settingsActionBusy: boolean;
  settingsPathPickerBusyTarget: SettingsPathPickerBusyTarget | null;
  modelPresetActions: ModelPresetSettingsActions;
  runtimeStatus: InferenceRuntimeDashboardStatus | null;
};

const GROUP_TITLES: Record<ModelPresetGroupId, string> = {
  'identity-launch': 'Identity & launch',
  'memory-compute': 'Memory & compute',
  sampling: 'Sampling',
  reasoning: 'Reasoning',
  speculative: 'Speculative decoding',
  lifecycle: 'Lifecycle & health',
};

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
  runtimeStatus,
}: ModelPresetsSectionProps) {
  const [openGroups, setOpenGroups] = React.useState<Record<ModelPresetGroupId, boolean>>({
    'identity-launch': true,
    'memory-compute': false,
    sampling: false,
    reasoning: false,
    speculative: false,
    lifecycle: false,
  });
  if (!dashboardConfig || !selectedModelPreset) {
    return null;
  }
  const preset = selectedModelPreset;
  const runtimeStatusMatchesPreset = runtimeStatus !== null
    && dashboardConfig.Server.ModelPresets.ActivePresetId === preset.id
    && runtimeStatus.activePresetId === preset.id
    && runtimeStatus.model === preset.Model;
  const reasoningEnabled = preset.Reasoning === 'on';
  const reasoningContentEnabled = reasoningEnabled && preset.ReasoningContent;
  const baseUrl = preset.BaseUrl || '';

  function toggleGroup(id: ModelPresetGroupId, next: boolean): void {
    setOpenGroups((previous) => ({ ...previous, [id]: next }));
  }

  const group = (id: ModelPresetGroupId, children: ReactNode): ReactNode => (
    <ModelPresetGroup id={id} open={openGroups[id]} summary={summarizeModelPresetGroup(id, preset)} onToggle={toggleGroup}>
      {children}
    </ModelPresetGroup>
  );

  return (
    <div id="mp-body" className="exl3">
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
      </div>

      {group('identity-launch', (
        <>
          <SettingsSectionField sectionId="model-presets" label="Preset name">
            <input value={preset.label} onChange={(event) => modelPresetActions.setString('label', event.target.value)} />
          </SettingsSectionField>
          {!preset.ExternalServerEnabled ? (
            <SettingsSectionField sectionId="model-presets" label="Model directory (EXL3)">
              <div className="settings-live-nav-control">
                <input
                  value={preset.ModelPath || ''}
                  onChange={(event) => modelPresetActions.setModelPath(event.target.value.trim() || null)}
                />
                <button type="button" onClick={() => { void modelPresetActions.pickModelPath(); }} disabled={settingsActionBusy}>
                  {isModelPresetPickerBusy(settingsPathPickerBusyTarget) ? 'Opening…' : 'Browse…'}
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
          <SettingsSectionField sectionId="model-presets" label="Base URL">
            <div className="settings-live-nav-control">
              <input value={baseUrl} onChange={(event) => modelPresetActions.setNullableString('BaseUrl', event.target.value || null)} />
              <button type="button" disabled={settingsActionBusy} onClick={() => { void modelPresetActions.testBaseUrl(baseUrl, preset.HealthcheckTimeoutMs); }}>Test</button>
            </div>
          </SettingsSectionField>
        </>
      ))}

      {group('memory-compute', (
        <>
          <SettingsSectionField sectionId="model-presets" label="NumCtx">
            <input type="number" value={preset.NumCtx} onChange={(event) => modelPresetActions.setInteger('NumCtx', parseIntegerInput(event.target.value, preset.NumCtx))} />
          </SettingsSectionField>
          <ModelPresetControl preset={preset} field="ParallelSlots" label="ParallelSlots">
            <input type="number" value={preset.ParallelSlots} onChange={(event) => modelPresetActions.setInteger('ParallelSlots', parseIntegerInput(event.target.value, preset.ParallelSlots))} />
          </ModelPresetControl>
          <ModelPresetControl preset={preset} field="UBatchSize" label="UBatchSize">
            <input type="number" value={preset.UBatchSize} onChange={(event) => modelPresetActions.setInteger('UBatchSize', parseIntegerInput(event.target.value, preset.UBatchSize))} />
          </ModelPresetControl>
          <ModelPresetControl preset={preset} field="CacheRam" label="CacheRam">
            <input type="number" value={preset.CacheRam} onChange={(event) => modelPresetActions.setInteger('CacheRam', parseIntegerInput(event.target.value, preset.CacheRam))} />
          </ModelPresetControl>
          <ModelPresetControl preset={preset} field="CacheRecurrentRam" label="CacheRecurrentRam">
            <input type="number" value={preset.CacheRecurrentRam} onChange={(event) => modelPresetActions.setInteger('CacheRecurrentRam', parseIntegerInput(event.target.value, preset.CacheRecurrentRam))} />
          </ModelPresetControl>
          <ModelPresetControl preset={preset} field="KvCacheQuantization" label="KV cache quant">
            <select value={preset.KvCacheQuantization} onChange={(event) => {
              const value = ModelKvCacheQuantizationSchema.safeParse(event.target.value);
              if (value.success) modelPresetActions.setKvCacheQuantization(value.data);
            }}>
              {ModelKvCacheQuantizationSchema.options.map((option) => (
                <option key={option} value={option}>{option}</option>
              ))}
            </select>
          </ModelPresetControl>
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
            <SettingsSectionField sectionId="model-presets" label="Reasoning effort">
              <select
                value={preset.ReasoningEffort}
                onChange={(event) => {
                  const value = ReasoningEffortSchema.safeParse(event.target.value);
                  if (value.success) modelPresetActions.setReasoningEffort(value.data);
                }}
              >
                {ReasoningEffortSchema.options.map((option) => (
                  <option key={option} value={option}>{option}</option>
                ))}
              </select>
            </SettingsSectionField>
          ) : null}
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
          <ModelPresetControl preset={preset} field="ReasoningBudget" label="ReasoningBudget">
            <input type="number" value={preset.ReasoningBudget} onChange={(event) => modelPresetActions.setInteger('ReasoningBudget', parseIntegerInput(event.target.value, preset.ReasoningBudget))} />
          </ModelPresetControl>
          <ModelPresetControl preset={preset} field="ReasoningBudgetMessage" label="ReasoningBudgetMessage" className="w4">
            <textarea rows={3} value={preset.ReasoningBudgetMessage || ''} onChange={(event) => modelPresetActions.setNullableString('ReasoningBudgetMessage', event.target.value || null)} />
          </ModelPresetControl>
        </>
      ))}

      {group('speculative', (
        <>
          <ModelPresetControl preset={preset} field="SpeculativeEnabled" label="Enable speculative decoding">
            <label className="settings-live-toggle-control">
              <input type="checkbox" checked={preset.SpeculativeEnabled} onChange={(event) => modelPresetActions.setBoolean('SpeculativeEnabled', event.target.checked)} />
              <span>{preset.SpeculativeEnabled ? 'Enabled' : 'Disabled'}</span>
            </label>
          </ModelPresetControl>
          {preset.SpeculativeEnabled ? (
            <ModelPresetControl preset={preset} field="SpeculativeDraftMax" label="SpeculativeDraftMax">
              <input type="number" value={preset.SpeculativeDraftMax} onChange={(event) => modelPresetActions.setInteger('SpeculativeDraftMax', parseIntegerInput(event.target.value, preset.SpeculativeDraftMax))} />
            </ModelPresetControl>
          ) : null}
          {preset.SpeculativeEnabled ? (
            <ModelPresetControl preset={preset} field="SpeculativeDynamic" label="SpeculativeDynamic">
              <label className="settings-live-toggle-control">
                <input type="checkbox" checked={preset.SpeculativeDynamic} onChange={(event) => modelPresetActions.setBoolean('SpeculativeDynamic', event.target.checked)} />
                <span>{preset.SpeculativeDynamic ? 'Enabled' : 'Disabled'}</span>
              </label>
            </ModelPresetControl>
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
          <ModelPresetControl preset={preset} field="IdleAction" label="IdleAction">
            <select value={preset.IdleAction} onChange={(event) => {
              const value = ModelIdleActionSchema.safeParse(event.target.value);
              if (value.success) modelPresetActions.setIdleAction(value.data);
            }}>
              <option value="none">Stay resident</option>
              <option value="freeze">Freeze model</option>
              <option value="unload">Full unload</option>
            </select>
          </ModelPresetControl>
          <SettingsSectionField sectionId="model-presets" label="SleepIdleSeconds">
            <input
              type="number"
              value={preset.SleepIdleSeconds}
              disabled={preset.IdleAction === 'none'}
              onChange={(event) => modelPresetActions.setInteger('SleepIdleSeconds', parseIntegerInput(event.target.value, preset.SleepIdleSeconds))}
            />
          </SettingsSectionField>
          <VisionPresetControls
            preset={preset}
            modelPresetActions={modelPresetActions}
            imageTokenBudget={runtimeStatusMatchesPreset ? runtimeStatus.imageTokenBudget : null}
            gpuFreeBytes={runtimeStatusMatchesPreset ? runtimeStatus.gpuFreeBytes : null}
          />
        </>
      ))}
      <div className="cond-note">Runtime changes take effect on Save settings → backend restart.</div>
    </div>
  );
}

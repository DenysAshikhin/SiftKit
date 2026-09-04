import { formatCompactTokenCount } from '../../lib/format';
import type { DashboardModelRuntimePreset } from '../../types';

export type ModelPresetGroupId =
  | 'identity-launch'
  | 'memory-compute'
  | 'sampling'
  | 'reasoning'
  | 'speculative'
  | 'lifecycle';

function seconds(ms: number): string {
  return `${Math.round(ms / 1000)}s`;
}

export function summarizeIdentity(preset: DashboardModelRuntimePreset): string {
  const model = preset.ModelPath || preset.Model;
  const location = preset.ExternalServerEnabled ? 'external' : 'managed';
  return `${model} · ${location} · ${preset.BaseUrl}`;
}

export function summarizeMemory(preset: DashboardModelRuntimePreset): string {
  return `ctx ${formatCompactTokenCount(preset.NumCtx)} · chunk ${preset.UBatchSize} · KV ${preset.KvCacheQuantization}`;
}

export function summarizeSampling(preset: DashboardModelRuntimePreset): string {
  return `temp ${preset.Temperature} · top-p ${preset.TopP} · top-k ${preset.TopK}`;
}

export function summarizeReasoning(preset: DashboardModelRuntimePreset): string {
  const perStep = preset.MaintainPerStepThinking ? 'on' : 'off';
  const effort = preset.Reasoning === 'on' ? ` · effort ${preset.ReasoningEffort}` : '';
  return `${preset.Reasoning}${effort} · per-step thinking ${perStep} · budget ${formatCompactTokenCount(preset.ReasoningBudget)}`;
}

export function summarizeSpeculative(preset: DashboardModelRuntimePreset): string {
  if (!preset.SpeculativeEnabled) {
    return 'off';
  }
  const window = preset.SpeculativeDynamic ? `dynamic ≤${preset.SpeculativeDraftMax}` : `${preset.SpeculativeDraftMax}`;
  return `on · draft-mtp · ${window}`;
}

export function summarizeLifecycle(preset: DashboardModelRuntimePreset): string {
  const idle = preset.IdleAction === 'none'
    ? 'stays resident'
    : `idle ${preset.IdleAction === 'freeze' ? 'freeze' : 'unload'} ${preset.SleepIdleSeconds}s`;
  return `startup ${seconds(preset.StartupTimeoutMs)} · probe ${seconds(preset.HealthcheckTimeoutMs)}/${seconds(preset.HealthcheckIntervalMs)} · ${idle}`;
}

export function summarizeModelPresetGroup(id: ModelPresetGroupId, preset: DashboardModelRuntimePreset): string {
  switch (id) {
    case 'identity-launch': return summarizeIdentity(preset);
    case 'memory-compute': return summarizeMemory(preset);
    case 'sampling': return summarizeSampling(preset);
    case 'reasoning': return summarizeReasoning(preset);
    case 'speculative': return summarizeSpeculative(preset);
    case 'lifecycle': return summarizeLifecycle(preset);
  }
}

export const MODEL_PRESET_GROUPS: { id: ModelPresetGroupId; title: string }[] = [
  { id: 'identity-launch', title: 'Identity & launch' },
  { id: 'memory-compute', title: 'Memory & compute' },
  { id: 'sampling', title: 'Sampling' },
  { id: 'reasoning', title: 'Reasoning' },
  { id: 'speculative', title: 'Speculative decoding' },
  { id: 'lifecycle', title: 'Lifecycle & health' },
];

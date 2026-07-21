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
  const model = preset.Backend === 'exl3'
    ? (preset.ModelPath || preset.Model)
    : preset.Model;
  const location = preset.ExternalServerEnabled ? 'external' : 'managed';
  return `${model} · ${location} · ${preset.BindHost}:${preset.Port}`;
}

export function summarizeMemory(preset: DashboardModelRuntimePreset): string {
  const ctx = `ctx ${formatCompactTokenCount(preset.NumCtx)}`;
  const kv = `KV ${preset.KvCacheQuantization}`;
  if (preset.Backend === 'exl3') {
    return `${ctx} · chunk ${preset.UBatchSize} · ${kv}`;
  }
  return `${ctx} · GPU ${preset.GpuLayers} · batch ${preset.BatchSize}/${preset.UBatchSize} · ${kv}`;
}

export function summarizeSampling(preset: DashboardModelRuntimePreset): string {
  return `temp ${preset.Temperature} · top-p ${preset.TopP} · top-k ${preset.TopK} · max ${formatCompactTokenCount(preset.MaxTokens)}`;
}

export function summarizeReasoning(preset: DashboardModelRuntimePreset): string {
  const perStep = preset.MaintainPerStepThinking ? 'on' : 'off';
  return `${preset.Reasoning} · per-step thinking ${perStep} · budget ${formatCompactTokenCount(preset.ReasoningBudget)}`;
}

export function summarizeSpeculative(preset: DashboardModelRuntimePreset): string {
  if (!preset.SpeculativeEnabled) {
    return 'off';
  }
  const type = preset.SpeculativeType;
  const detail = type.startsWith('ngram-')
    ? `N${preset.SpeculativeNgramSizeN} M${preset.SpeculativeNgramSizeM}`
    : `${preset.SpeculativeDraftMin}–${preset.SpeculativeDraftMax}`;
  return `on · ${type} · ${detail}`;
}

export function summarizeLifecycle(preset: DashboardModelRuntimePreset): string {
  return `startup ${seconds(preset.StartupTimeoutMs)} · probe ${seconds(preset.HealthcheckTimeoutMs)}/${seconds(preset.HealthcheckIntervalMs)} · idle unload ${preset.SleepIdleSeconds}s`;
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

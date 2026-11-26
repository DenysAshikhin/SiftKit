import type { ModelRuntimePreset } from '../config/types.ts';

/**
 * Sole in-memory owner of the normalized applied model preset.
 * Shared by admission (server-ops) and the optional runtime coordinator.
 */
export class AppliedModelPresetState {
  private preset: ModelRuntimePreset;
  private transient = false;

  constructor(initialPreset: ModelRuntimePreset) {
    this.preset = initialPreset;
  }

  getPreset(): ModelRuntimePreset {
    return this.preset;
  }

  /** Exact profile match, sampler and label fields included; residency compares loading identity instead. */
  isApplied(preset: ModelRuntimePreset): boolean {
    return JSON.stringify(preset) === JSON.stringify(this.preset);
  }

  /** True when a benchmark request applied this preset without saving it as the selection. */
  isTransient(): boolean {
    return this.transient;
  }

  getParallelSlots(): number {
    return this.preset.ParallelSlots;
  }

  applyPreset(preset: ModelRuntimePreset): void {
    this.preset = preset;
    this.transient = false;
  }

  applyTransientPreset(preset: ModelRuntimePreset): void {
    this.preset = preset;
    this.transient = true;
  }
}
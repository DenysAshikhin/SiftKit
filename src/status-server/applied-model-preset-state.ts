import type { ModelRuntimePreset } from '../config/types.js';

/**
 * Sole in-memory owner of the normalized applied model preset.
 * Shared by admission (server-ops) and the optional runtime coordinator.
 */
export class AppliedModelPresetState {
  private preset: ModelRuntimePreset;

  constructor(initialPreset: ModelRuntimePreset) {
    this.preset = initialPreset;
  }

  getPreset(): ModelRuntimePreset {
    return this.preset;
  }

  getParallelSlots(): number {
    return this.preset.ParallelSlots;
  }

  applyPreset(preset: ModelRuntimePreset): void {
    this.preset = preset;
  }
}
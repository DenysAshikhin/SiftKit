import {
  ManagedLlamaSettingsSchema,
  type ManagedLlamaSettings,
  type ModelRuntimePreset,
} from '@siftkit/contracts';
import {
  buildPresetRequestDefaults,
  type PresetRequestDefaults,
} from './preset-compatibility.js';

export class LlamaPresetAdapter {
  validatePreset(preset: ModelRuntimePreset): void {
    if (preset.Backend !== 'llama') {
      throw new Error(`preset=${preset.id} backend=${preset.Backend} cannot use the llama adapter`);
    }
  }

  buildLaunchSettings(preset: ModelRuntimePreset): ManagedLlamaSettings {
    this.validatePreset(preset);
    return ManagedLlamaSettingsSchema.parse(preset);
  }

  buildRequestDefaults(preset: ModelRuntimePreset): PresetRequestDefaults {
    this.validatePreset(preset);
    return buildPresetRequestDefaults(preset);
  }
}

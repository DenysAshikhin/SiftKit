import { getActiveModelPreset } from './getters.js';
import type { ModelRuntimePreset, SiftConfig } from './types.js';

/**
 * Rewrites the active preset — the one `getActiveModelPreset` resolves — with the
 * given fields. Every request boundary that used to carry ad-hoc overrides folds
 * them in here instead, so the active preset stays the single request source.
 */
export function overlayActivePreset(config: SiftConfig, fields: Partial<ModelRuntimePreset>): SiftConfig {
  const activePresetId = getActiveModelPreset(config).id;
  return {
    ...config,
    Server: {
      ...config.Server,
      ModelPresets: {
        ...config.Server.ModelPresets,
        Presets: config.Server.ModelPresets.Presets.map((preset) => (
          preset.id === activePresetId ? { ...preset, ...fields } : preset
        )),
      },
    },
  };
}

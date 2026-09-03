import { getActiveModelPreset } from './getters.js';
import type { ModelRuntimePreset, RuntimeLlamaCppConfig, SiftConfig } from './types.js';

/**
 * `Runtime.LlamaCpp` records what the serving process was actually launched with and
 * therefore outranks the persisted preset in `getConfiguredLlamaNumCtx`/`getConfiguredReasoning`.
 * An overlay of those two fields has to travel into that record as well or the getters
 * would keep answering with the superseded launch values. `BaseUrl` deliberately does not
 * travel: the live endpoint stays the one that is actually listening.
 */
function buildLaunchRecordOverlay(fields: Partial<ModelRuntimePreset>): RuntimeLlamaCppConfig {
  return {
    ...(fields.NumCtx === undefined ? {} : { NumCtx: fields.NumCtx }),
    ...(fields.Reasoning === undefined ? {} : { Reasoning: fields.Reasoning }),
  };
}

/**
 * Rewrites the active preset — the one `getActiveModelPreset` resolves — with the
 * given fields. Every request boundary that used to carry ad-hoc overrides folds
 * them in here instead, so the active preset stays the single request source.
 */
export function overlayActivePreset(config: SiftConfig, fields: Partial<ModelRuntimePreset>): SiftConfig {
  const activePresetId = getActiveModelPreset(config).id;
  return {
    ...config,
    Runtime: {
      ...config.Runtime,
      LlamaCpp: { ...config.Runtime.LlamaCpp, ...buildLaunchRecordOverlay(fields) },
    },
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

/** Explicit caller override (CLI --model, session snapshot) wins over host sync and preset. */
export function applyModelOverrideToConfig(config: SiftConfig, model: string | null | undefined): SiftConfig {
  const trimmed = typeof model === 'string' ? model.trim() : '';
  return trimmed ? overlayActivePreset(config, { Model: trimmed }) : config;
}

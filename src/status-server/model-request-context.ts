import {
  ModelRuntimePresetSchema,
  SiftConfigSchema,
  SiftPresetSchema,
  type ModelRuntimePreset,
  type SiftConfig,
} from '@siftkit/contracts';
import { z } from '../lib/zod.js';
import type { ModelRequestIntent } from '../lib/model-request-intent.js';
import { PresetCatalog } from '../preset-catalog.js';

export const ModelRequestContextSchema = z.object({
  operationPreset: SiftPresetSchema.nullable(),
  modelPreset: ModelRuntimePresetSchema,
  config: SiftConfigSchema,
}).strict();
export type ModelRequestContext = z.infer<typeof ModelRequestContextSchema>;

export function resolveModelRequestContext(
  config: SiftConfig,
  applied: ModelRuntimePreset,
  intent: ModelRequestIntent,
): ModelRequestContext {
  const operationPreset = intent.presetId === null
    ? null
    : PresetCatalog.fromPresets(config.Presets).requireById(intent.presetId);
  let modelPreset = applied;
  if (operationPreset !== null && operationPreset.modelPresetId !== null) {
    const referenced = config.Server.ModelPresets.Presets
      .find((preset) => preset.id === operationPreset.modelPresetId);
    if (referenced === undefined) {
      throw new Error(
        `Operation preset '${operationPreset.id}' references missing model preset '${operationPreset.modelPresetId}'.`,
      );
    }
    modelPreset = referenced;
  }

  if (intent.model !== null && intent.model !== modelPreset.Model) {
    const matches = config.Server.ModelPresets.Presets.filter((preset) => preset.Model === intent.model);
    const [matched] = matches;
    if (matched === undefined) {
      throw new Error(`CLI model '${intent.model}' does not match any configured model preset.`);
    }
    if (matches.length > 1) {
      throw new Error(`CLI model '${intent.model}' is ambiguous: ${matches.map((preset) => preset.id).join(', ')}.`);
    }
    modelPreset = matched;
  }

  const executionConfig = structuredClone(config);
  const modelIndex = executionConfig.Server.ModelPresets.Presets
    .findIndex((preset) => preset.id === modelPreset.id);
  if (modelIndex < 0) throw new Error(`Model preset '${modelPreset.id}' does not exist.`);
  executionConfig.Server.ModelPresets.Presets[modelIndex] = structuredClone(modelPreset);
  executionConfig.Server.ModelPresets.ActivePresetId = modelPreset.id;
  return ModelRequestContextSchema.parse({
    operationPreset,
    modelPreset: structuredClone(modelPreset),
    config: executionConfig,
  });
}

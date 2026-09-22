import fs from 'node:fs';
import path from 'node:path';

import { ModelRuntimePresetSchema, SiftConfigSchema } from '@siftkit/contracts';
import { getDefaultConfigObject } from '../../src/config/defaults.js';
import type { SiftConfig } from '../../src/config/types.js';
import { createManagedTempDir } from './temp-dirs.js';

/** The three validated model profile IDs used by preset routing tests. */
export const PRESET_ROUTING_MODEL_A = 'model-a';
export const PRESET_ROUTING_MODEL_B = 'model-b';
export const PRESET_ROUTING_MODEL_C = 'model-c';

// Valid A/B/C models with real directories; search uses B, agent uses C, other operations inherit.
export function createPresetRoutingConfig(): SiftConfig {
  const base = getDefaultConfigObject();
  const template = base.Server.ModelPresets.Presets[0];
  if (!template) {
    throw new Error('Default model preset is missing.');
  }
  const modelRoot = createManagedTempDir('siftkit-preset-routing-');
  const presets = [PRESET_ROUTING_MODEL_A, PRESET_ROUTING_MODEL_B, PRESET_ROUTING_MODEL_C].map((id) => {
    const modelPath = path.join(modelRoot, id);
    fs.mkdirSync(modelPath, { recursive: true });
    return ModelRuntimePresetSchema.parse({
      ...template,
      id,
      label: id,
      Model: id,
      ModelPath: modelPath,
    });
  });
  return SiftConfigSchema.parse({
    ...base,
    Server: {
      ...base.Server,
      ModelPresets: {
        Presets: presets,
        ActivePresetId: PRESET_ROUTING_MODEL_A,
      },
      Engines: {
        ...base.Server.Engines,
        Exl3: { ...base.Server.Engines.Exl3, ModelRoot: modelRoot },
      },
    },
    Presets: base.Presets.map((preset) => {
      if (preset.id === 'repo-search') return { ...preset, modelPresetId: PRESET_ROUTING_MODEL_B };
      if (preset.id === 'repo-agent') return { ...preset, modelPresetId: PRESET_ROUTING_MODEL_C };
      return preset;
    }),
  });
}

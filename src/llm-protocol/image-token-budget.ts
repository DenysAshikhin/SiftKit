import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  ImageTokenBudgetSchema,
  VisionEncoderGeometrySchema,
  type ImageTokenBudget,
  type VisionEncoderGeometry,
} from '@siftkit/contracts';

import {
  SIFT_FALLBACK_IMAGE_MERGE_SIZE,
  SIFT_FALLBACK_IMAGE_PATCH_SIZE,
  SIFT_FALLBACK_VISION_HIDDEN_SIZE,
  SIFT_FALLBACK_VISION_INTERMEDIATE_SIZE,
  SIFT_IMAGE_TOKEN_ESTIMATE,
} from '../config/constants.js';
import type { ModelRuntimePreset } from '../config/types.js';
import { parseJsonValueText } from '../lib/json.js';
import { z } from '../lib/zod.js';
import { serverLogger } from '../status-server/server-logger.js';

/**
 * Two vintages of the same file. Older Qwen processors carry a flat `max_pixels`; the
 * `Qwen2VLImageProcessorFast` generation moved it to `size.longest_edge`, which is still a
 * total pixel count despite the name. Both are read, newer key first.
 */
const PreprocessorConfigSchema = z.object({
  patch_size: z.number().int().positive(),
  merge_size: z.number().int().positive(),
  max_pixels: z.number().int().positive().optional(),
  size: z.object({
    longest_edge: z.number().int().positive().optional(),
  }).optional(),
});

const ModelConfigSchema = z.object({
  vision_config: z.object({
    hidden_size: z.number().int().positive().optional(),
    intermediate_size: z.number().int().positive().optional(),
    spatial_merge_size: z.number().int().positive().optional(),
  }).optional(),
});

function readConfiguredMaxPixels(config: z.infer<typeof PreprocessorConfigSchema>): number | undefined {
  return config.size?.longest_edge ?? config.max_pixels;
}

const budgetByPresetAndModelPath = new Map<string, ImageTokenBudget>();

/** Test seam. Production code never calls this. */
export function clearImageTokenBudgetCache(): void {
  budgetByPresetAndModelPath.clear();
}

function buildBudget(
  pixelsPerToken: number,
  configuredMaxPixels: number | undefined,
  source: ImageTokenBudget['source'],
  encoder: VisionEncoderGeometry,
): ImageTokenBudget {
  const affordableMaxPixels = SIFT_IMAGE_TOKEN_ESTIMATE * pixelsPerToken;
  const maxPixels = configuredMaxPixels === undefined
    ? affordableMaxPixels
    : Math.min(configuredMaxPixels, affordableMaxPixels);
  return ImageTokenBudgetSchema.parse({
    pixelsPerToken,
    maxPixels,
    maxImageTokens: Math.ceil(maxPixels / pixelsPerToken),
    encoder,
    source,
  });
}

function fallbackEncoder(
  preset: ModelRuntimePreset,
  patchesPerToken: number,
  reason: string,
): VisionEncoderGeometry {
  const encoder = VisionEncoderGeometrySchema.parse({
    hiddenSize: SIFT_FALLBACK_VISION_HIDDEN_SIZE,
    intermediateSize: SIFT_FALLBACK_VISION_INTERMEDIATE_SIZE,
    patchesPerToken,
  });
  serverLogger.event({
    scope: 'img',
    id: preset.id,
    event: 'vision_encoder_geometry_fallback',
    fields: `reason=${reason} hidden_size=${encoder.hiddenSize} `
      + `intermediate_size=${encoder.intermediateSize} patches_per_token=${encoder.patchesPerToken}`,
  });
  return encoder;
}

function fallbackBudget(preset: ModelRuntimePreset, reason: string): ImageTokenBudget {
  const encoder = fallbackEncoder(
    preset,
    SIFT_FALLBACK_IMAGE_MERGE_SIZE ** 2,
    reason,
  );
  const budget = buildBudget(
    (SIFT_FALLBACK_IMAGE_PATCH_SIZE * SIFT_FALLBACK_IMAGE_MERGE_SIZE) ** 2,
    undefined,
    'fallback',
    encoder,
  );
  serverLogger.event({
    scope: 'img',
    id: preset.id,
    event: 'token_budget_fallback',
    fields: `reason=${reason} pixels_per_token=${budget.pixelsPerToken} max_pixels=${budget.maxPixels}`,
  });
  return budget;
}

function readEncoderGeometry(
  preset: ModelRuntimePreset,
  modelPath: string,
  fallbackPatchesPerToken: number,
): VisionEncoderGeometry {
  const configPath = join(modelPath, 'config.json');
  if (!existsSync(configPath)) {
    return fallbackEncoder(preset, fallbackPatchesPerToken, 'config_json_missing');
  }

  try {
    const parsed = ModelConfigSchema.safeParse(
      parseJsonValueText(readFileSync(configPath, 'utf8')),
    );
    if (!parsed.success) {
      return fallbackEncoder(preset, fallbackPatchesPerToken, 'config_json_invalid');
    }
    const vision = parsed.data.vision_config;
    const hasCompleteGeometry = vision?.hidden_size !== undefined
      && vision.intermediate_size !== undefined;
    if (!hasCompleteGeometry) {
      return fallbackEncoder(preset, fallbackPatchesPerToken, 'vision_config_missing');
    }
    return VisionEncoderGeometrySchema.parse({
      hiddenSize: vision.hidden_size,
      intermediateSize: vision.intermediate_size,
      patchesPerToken: vision.spatial_merge_size === undefined
        ? fallbackPatchesPerToken
        : vision.spatial_merge_size ** 2,
    });
  } catch (error) {
    return fallbackEncoder(preset, fallbackPatchesPerToken, `config_json_read_failed:${String(error)}`);
  }
}

function readBudget(preset: ModelRuntimePreset): ImageTokenBudget {
  const modelPath = typeof preset.ModelPath === 'string' ? preset.ModelPath.trim() : '';
  if (!modelPath) {
    return fallbackBudget(preset, 'model_path_missing');
  }
  const configPath = join(modelPath, 'preprocessor_config.json');
  if (!existsSync(configPath)) {
    return fallbackBudget(preset, 'preprocessor_config_missing');
  }
  const parsed = PreprocessorConfigSchema.safeParse(
    parseJsonValueText(readFileSync(configPath, 'utf8')),
  );
  if (!parsed.success) {
    return fallbackBudget(preset, 'preprocessor_config_invalid');
  }
  return buildBudget(
    (parsed.data.patch_size * parsed.data.merge_size) ** 2,
    readConfiguredMaxPixels(parsed.data),
    'preprocessor_config',
    readEncoderGeometry(preset, modelPath, parsed.data.merge_size ** 2),
  );
}

/**
 * The pixel ceiling a single image may occupy for this preset. Cached per preset id and ModelPath
 * logged with its source, so a silently-defaulted ceiling is visible in the log rather than
 * showing up later as an unexplained downscale.
 */
export function resolveImageTokenBudget(preset: ModelRuntimePreset): ImageTokenBudget {
  const modelPath = typeof preset.ModelPath === 'string' ? preset.ModelPath.trim() : '';
  const cacheKey = `${preset.id}\u0000${modelPath}`;
  const cached = budgetByPresetAndModelPath.get(cacheKey);
  if (cached) {
    return cached;
  }
  let budget: ImageTokenBudget;
  try {
    budget = readBudget(preset);
  } catch (error) {
    budget = fallbackBudget(preset, `preprocessor_config_read_failed:${String(error)}`);
  }
  budgetByPresetAndModelPath.set(cacheKey, budget);
  serverLogger.event({
    scope: 'img',
    id: preset.id,
    event: 'token_budget_resolved',
    fields: `source=${budget.source} pixels_per_token=${budget.pixelsPerToken} `
      + `max_pixels=${budget.maxPixels} max_image_tokens=${budget.maxImageTokens} `
      + `encoder_hidden_size=${budget.encoder.hiddenSize} `
      + `encoder_intermediate_size=${budget.encoder.intermediateSize} `
      + `encoder_patches_per_token=${budget.encoder.patchesPerToken}`
      + (budget.source === 'fallback'
        ? ' note=preprocessor_config.json_unavailable_using_default_ratio'
        : ''),
  });
  return budget;
}

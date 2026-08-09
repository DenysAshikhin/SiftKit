import type { ModelRuntimePreset } from '../config/types.js';
import { admitImageDataUrls, type AdmittedImage } from './image-admission.js';
import { assertPresetAcceptsImages } from './image-attachments.js';
import { resolveImageTokenBudget } from './image-token-budget.js';

export function admitImagesForPreset(
  preset: ModelRuntimePreset,
  imageDataUrls: readonly string[],
): AdmittedImage[] {
  assertPresetAcceptsImages(preset, imageDataUrls);
  if (imageDataUrls.length === 0) {
    return [];
  }
  return admitImageDataUrls(
    imageDataUrls,
    resolveImageTokenBudget(preset),
    preset.VisionMaxImagePixels,
  );
}

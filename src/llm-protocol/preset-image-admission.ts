import type { ImageMetadata } from '@siftkit/contracts';
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

/** Admitted payloads and their metadata, in the shape a chat submission or queue delivery records. */
export function admitChatImages(preset: ModelRuntimePreset, imageDataUrls: readonly string[]): { images: string[]; imageMeta: ImageMetadata[] } {
  const admitted = admitImagesForPreset(preset, imageDataUrls);
  return { images: admitted.map(image => image.dataUrl), imageMeta: admitted.map(image => image.metadata) };
}

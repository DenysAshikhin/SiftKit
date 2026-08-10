import { z } from 'zod';

/**
 * Decoded byte length of a base64 payload, without decoding it. Every 4 characters carry
 * 3 bytes; trailing `=` padding characters carry none.
 */
function base64PayloadByteLength(base64: string): number {
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0;
  return Math.floor((base64.length * 3) / 4) - padding;
}

export const SIFT_MAX_IMAGE_BYTES = 20 * 1024 * 1024;

export const ImageMimeSchema = z.enum(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
export type ImageMime = z.infer<typeof ImageMimeSchema>;

export type ImageDimensions = { width: number; height: number };

export function computeImageTargetDimensions(
  width: number,
  height: number,
  maxPixels: number,
): ImageDimensions | null {
  if (width * height <= maxPixels) {
    return null;
  }
  const scale = Math.sqrt(maxPixels / (width * height));
  return {
    width: Math.max(1, Math.floor(width * scale)),
    height: Math.max(1, Math.floor(height * scale)),
  };
}

const IMAGE_DATA_URL_PREFIX_PATTERN = /^data:(image\/\w+);base64,/;

/**
 * Splits an image data URL into its mime type and base64 payload, or `null` when the string is
 * not one. The sole parser: `ImageDataUrlSchema` validates through it, so nothing that accepts a
 * data URL can disagree with something that later takes it apart.
 */
export function splitImageDataUrl(dataUrl: string): { mime: ImageMime; base64: string } | null {
  const match = IMAGE_DATA_URL_PREFIX_PATTERN.exec(dataUrl);
  if (match === null) return null;
  const mime = ImageMimeSchema.safeParse(match[1]);
  if (!mime.success) return null;
  return { mime: mime.data, base64: dataUrl.slice(match[0].length) };
}

export const ImageDataUrlSchema = z.string().refine(
  (val) => {
    const split = splitImageDataUrl(val);
    return split !== null && base64PayloadByteLength(split.base64) <= SIFT_MAX_IMAGE_BYTES;
  },
  { message: 'supported-image' },
);
export type ImageDataUrl = z.infer<typeof ImageDataUrlSchema>;

/**
 * Multiplier on the vision encoder's per-patch residual+MLP footprint, covering Q/K/V
 * projections, attention workspace, and allocator slack. Calibrated in Task 25.
 */
export const SIFT_VISION_PEAK_VRAM_WORKING_SET_FACTOR = 2.5;

/** Encoder activations are fp16. */
export const SIFT_VISION_ACTIVATION_BYTES = 2;

export const VisionEncoderGeometrySchema = z.object({
  hiddenSize: z.number().int().positive(),
  intermediateSize: z.number().int().positive(),
  patchesPerToken: z.number().int().positive(),
});
export type VisionEncoderGeometry = z.infer<typeof VisionEncoderGeometrySchema>;

export const ImageTokenBudgetSchema = z.object({
  pixelsPerToken: z.number().int().positive(),
  maxPixels: z.number().int().positive(),
  maxImageTokens: z.number().int().positive(),
  encoder: VisionEncoderGeometrySchema,
  source: z.enum(['preprocessor_config', 'fallback']),
});
export type ImageTokenBudget = z.infer<typeof ImageTokenBudgetSchema>;

/**
 * The pixel ceiling actually applied to an image: the model's ceiling, narrowed by the user's
 * cap. Both are plain pixel counts, so this is a min rather than a second constraint.
 */
export function resolveEffectiveImagePixelCeiling(
  budget: ImageTokenBudget,
  visionMaxImagePixels: number,
): number {
  if (visionMaxImagePixels <= 0) {
    return budget.maxPixels;
  }
  return Math.min(budget.maxPixels, visionMaxImagePixels);
}

/**
 * Estimated peak VRAM the vision encoder needs free while it processes one image. The spike is
 * transient and scales with the image token count.
 */
export function estimateVisionPeakVramBytes(
  imageTokens: number,
  encoder: VisionEncoderGeometry,
): number {
  const bytesPerPatch = (encoder.hiddenSize + encoder.intermediateSize)
    * SIFT_VISION_ACTIVATION_BYTES
    * SIFT_VISION_PEAK_VRAM_WORKING_SET_FACTOR;
  return Math.round(imageTokens * encoder.patchesPerToken * bytesPerPatch);
}

/** Estimates the transient encode peak for a preset's effective pixel ceiling. */
export function estimateVisionPeakVramBytesForImagePixels(
  budget: ImageTokenBudget,
  visionMaxImagePixels: number,
): number {
  const effectivePixels = resolveEffectiveImagePixelCeiling(budget, visionMaxImagePixels);
  const imageTokens = Math.ceil(effectivePixels / budget.pixelsPerToken);
  return estimateVisionPeakVramBytes(imageTokens, budget.encoder);
}

/** Persisted alongside a message so the dashboard annotation costs nothing to render. */
export const ImageMetadataSchema = z.object({
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  originalWidth: z.number().int().positive(),
  originalHeight: z.number().int().positive(),
  mime: ImageMimeSchema,
  byteLength: z.number().int().nonnegative(),
  tokenEstimate: z.number().int().nonnegative(),
  resized: z.boolean(),
  caption: z.string().nullable(),
});
export type ImageMetadata = z.infer<typeof ImageMetadataSchema>;

export const ImageCaptionResponseSchema = z.object({ caption: z.string().min(1) });
export type ImageCaptionResponse = z.infer<typeof ImageCaptionResponseSchema>;

export const ImageVramFindingSchema = z.object({
  level: z.enum(['warning', 'error']),
  message: z.string().min(1),
});
export type ImageVramFinding = z.infer<typeof ImageVramFindingSchema>;

/** Below this multiple of the encode peak, an image is close enough to the limit to say so. */
const COMFORTABLE_HEADROOM_MULTIPLE = 2;

function formatMegabytes(bytes: number): string {
  return `${Math.round(bytes / 1_048_576)} MB`;
}

/**
 * Grades free VRAM against the peak one image encode needs. Deliberately says nothing about
 * model-load memory: the encode spike is transient and the MP setting is the only knob that
 * moves it, so pointing at anything else here would send the user to the wrong control.
 *
 * `freeBytes: null` means the probe could not read the GPU — return null and stay silent rather
 * than warn on a guess.
 */
export function assessImageVramHeadroom(input: {
  freeBytes: number | null;
  peakEncodeBytes: number;
}): ImageVramFinding | null {
  const { freeBytes, peakEncodeBytes } = input;
  if (freeBytes === null || peakEncodeBytes <= 0) {
    return null;
  }
  if (freeBytes <= peakEncodeBytes) {
    return {
      level: 'error',
      message: `Only ${formatMegabytes(freeBytes)} of GPU memory is free, but encoding one image at `
        + `this size needs about ${formatMegabytes(peakEncodeBytes)}. Sending an image is likely to `
        + `fail — lower Max image size, or free GPU memory.`,
    };
  }
  if (freeBytes < peakEncodeBytes * COMFORTABLE_HEADROOM_MULTIPLE) {
    return {
      level: 'warning',
      message: `${formatMegabytes(freeBytes)} of GPU memory is free and encoding one image at this `
        + `size needs about ${formatMegabytes(peakEncodeBytes)}. That should work, but there is `
        + `little margin — consider lowering Max image size.`,
    };
  }
  return null;
}

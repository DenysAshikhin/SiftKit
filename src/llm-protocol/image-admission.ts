import { ResizeFilterType, Transformer } from '@napi-rs/image';
import {
  ImageDataUrlSchema,
  ImageMetadataSchema,
  computeImageTargetDimensions,
  resolveEffectiveImagePixelCeiling,
  type ImageDimensions,
  type ImageMetadata,
  type ImageTokenBudget,
} from '@siftkit/contracts';

export type AdmittedImage = { dataUrl: string; metadata: ImageMetadata };

/**
 * `@napi-rs/image` cannot decode GIF at all, so GIF dimensions come from the header: bytes
 * 6-9 of the logical screen descriptor are width then height, little-endian uint16.
 */
function readGifDimensions(buffer: Buffer): ImageDimensions {
  if (buffer.byteLength < 10) {
    throw new Error('image is not a readable GIF header: shorter than 10 bytes');
  }
  const dimensions = { width: buffer.readUInt16LE(6), height: buffer.readUInt16LE(8) };
  if (dimensions.width <= 0 || dimensions.height <= 0) {
    throw new Error('GIF dimensions must be positive');
  }
  return dimensions;
}

export function readImageDimensions(buffer: Buffer, mime: string): ImageDimensions {
  if (mime === 'image/gif') {
    return readGifDimensions(buffer);
  }
  const metadata = new Transformer(buffer).metadataSync();
  if (!Number.isFinite(metadata.width) || !Number.isFinite(metadata.height)
    || metadata.width <= 0 || metadata.height <= 0) {
    throw new Error(`image dimensions could not be read from ${mime} data`);
  }
  return { width: metadata.width, height: metadata.height };
}

/**
 * Lanczos3 because the dominant input is UI screenshots, where glyph legibility after the
 * downscale is the whole point.
 */
export function downscaleImageBuffer(
  buffer: Buffer,
  mime: string,
  target: ImageDimensions,
): Buffer {
  if (mime === 'image/gif') {
    throw new Error('gif images cannot be resized server-side; resize the gif and retry');
  }
  const resized = new Transformer(buffer)
    .resize(target.width, target.height, ResizeFilterType.Lanczos3);
  if (mime === 'image/jpeg') return resized.jpegSync(90);
  if (mime === 'image/webp') return resized.webpSync(90);
  return resized.pngSync();
}

function formatMegapixels(width: number, height: number): string {
  return ((width * height) / 1_000_000).toFixed(1);
}

/**
 * The one place an image becomes admissible. Oversized images are downscaled to the preset's
 * pixel ceiling; GIF cannot be decoded by the encoder, so an oversized GIF is rejected with the
 * same numbers a resize would have used.
 */
export function admitImageBuffer(
  buffer: Buffer,
  mime: string,
  budget: ImageTokenBudget,
  visionMaxImagePixels = 0,
): AdmittedImage {
  const original = readImageDimensions(buffer, mime);
  const effectiveMaxPixels = resolveEffectiveImagePixelCeiling(budget, visionMaxImagePixels);
  const target = computeImageTargetDimensions(original.width, original.height, effectiveMaxPixels);
  if (target === null) {
    return buildAdmittedImage(buffer, mime, original, original, budget, false);
  }
  if (mime === 'image/gif') {
    throw new Error(
      `image is ${original.width}×${original.height} (${formatMegapixels(original.width, original.height)} MP); `
      + `this preset accepts up to ${(effectiveMaxPixels / 1_000_000).toFixed(1)} MP `
      + `(≈${Math.ceil(effectiveMaxPixels / budget.pixelsPerToken)} image tokens) — resize and retry`,
    );
  }
  const resized = downscaleImageBuffer(buffer, mime, target);
  return buildAdmittedImage(resized, mime, target, original, budget, true);
}

function buildAdmittedImage(
  buffer: Buffer,
  mime: string,
  dimensions: ImageDimensions,
  original: ImageDimensions,
  budget: ImageTokenBudget,
  resized: boolean,
): AdmittedImage {
  return {
    dataUrl: `data:${mime};base64,${buffer.toString('base64')}`,
    // The data URL is deliberately outside `metadata`: metadata is persisted as JSON on the
    // message row, and a nested copy of the image would double every stored attachment.
    metadata: ImageMetadataSchema.parse({
      width: dimensions.width,
      height: dimensions.height,
      originalWidth: original.width,
      originalHeight: original.height,
      mime,
      byteLength: buffer.byteLength,
      tokenEstimate: Math.ceil((dimensions.width * dimensions.height) / budget.pixelsPerToken),
      resized,
      caption: null,
    }),
  };
}

export function admitImageDataUrl(
  dataUrl: string,
  budget: ImageTokenBudget,
  visionMaxImagePixels = 0,
): AdmittedImage {
  const validated = ImageDataUrlSchema.parse(dataUrl);
  const separator = validated.indexOf(';base64,');
  const mime = validated.slice('data:'.length, separator);
  const buffer = Buffer.from(validated.slice(separator + ';base64,'.length), 'base64');
  return admitImageBuffer(buffer, mime, budget, visionMaxImagePixels);
}

export function admitImageDataUrls(
  dataUrls: readonly string[],
  budget: ImageTokenBudget,
  visionMaxImagePixels = 0,
): AdmittedImage[] {
  return dataUrls.map((dataUrl) => admitImageDataUrl(dataUrl, budget, visionMaxImagePixels));
}

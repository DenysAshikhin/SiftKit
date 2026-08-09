import {
  ImageDataUrlSchema,
  ImageMimeSchema,
  computeImageTargetDimensions,
  type ImageDataUrl,
  type ImageMime,
} from '@siftkit/contracts';

export type PendingImage = { dataUrl: ImageDataUrl; note: string | null };

function mimeOf(dataUrl: ImageDataUrl): ImageMime {
  const separator = dataUrl.indexOf(';base64,');
  if (separator < 0) {
    throw new Error('invalid image data URL: missing base64 separator');
  }
  return ImageMimeSchema.parse(dataUrl.slice('data:'.length, separator));
}

async function blobToDataUrl(blob: Blob): Promise<ImageDataUrl> {
  const buffer = await blob.arrayBuffer();
  let binary = '';
  for (const byte of new Uint8Array(buffer)) {
    binary += String.fromCharCode(byte);
  }
  return ImageDataUrlSchema.parse(`data:${blob.type};base64,${btoa(binary)}`);
}

/**
 * Downscales in the browser so an oversized paste never becomes an oversized POST. Browsers
 * decode GIF natively, so this is also the only path that can shrink one; the result is a
 * single first frame converted to PNG, which is what the model sees anyway.
 */
export async function downscaleDataUrl(dataUrl: string, maxPixels: number): Promise<PendingImage> {
  const admittedDataUrl = ImageDataUrlSchema.parse(dataUrl);
  const inputMime = mimeOf(admittedDataUrl);
  const bitmap = await createImageBitmap(await (await fetch(admittedDataUrl)).blob());
  const target = computeImageTargetDimensions(bitmap.width, bitmap.height, maxPixels);
  if (target === null) {
    bitmap.close();
    return { dataUrl: admittedDataUrl, note: null };
  }

  try {
    const canvas = new OffscreenCanvas(target.width, target.height);
    const context = canvas.getContext('2d');
    if (!context) {
      throw new Error('image downscaling is unavailable: 2d canvas context could not be created');
    }
    context.drawImage(bitmap, 0, 0, target.width, target.height);
    const formatNote = inputMime === 'image/gif' ? '; GIF frame one converted to PNG' : '';
    const note = `Resized from ${bitmap.width}×${bitmap.height} to ${target.width}×${target.height}${formatNote}`;
    const outputType = inputMime === 'image/gif' ? 'image/png' : inputMime;
    const outputBlob = await canvas.convertToBlob({ type: outputType });
    return { dataUrl: await blobToDataUrl(outputBlob), note };
  } finally {
    bitmap.close();
  }
}

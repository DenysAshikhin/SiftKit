import { Transformer } from '@napi-rs/image';

/** A 1x1 GIF87a. GIF cannot be encoded by @napi-rs/image, so it is a literal. */
const GIF_1X1_BASE64 = 'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

export function gifBuffer(): Buffer {
  return Buffer.from(GIF_1X1_BASE64, 'base64');
}

/**
 * A GIF header with the requested logical screen size. Bytes 6-9 are the width and height as
 * little-endian uint16, which is all readImageDimensions reads.
 */
export function gifBufferWithSize(width: number, height: number): Buffer {
  const buffer = Buffer.from(gifBuffer());
  buffer.writeUInt16LE(width, 6);
  buffer.writeUInt16LE(height, 8);
  return buffer;
}

/** A solid-colour RGBA raster, encoded to the requested format. */
export function rasterBuffer(
  format: 'png' | 'jpeg' | 'webp',
  width: number,
  height: number,
): Buffer {
  const pixels = Buffer.alloc(width * height * 4);
  for (let index = 0; index < pixels.length; index += 4) {
    pixels[index] = 200;
    pixels[index + 1] = 120;
    pixels[index + 2] = 40;
    pixels[index + 3] = 255;
  }
  const transformer = Transformer.fromRgbaPixels(pixels, width, height);
  if (format === 'png') return transformer.pngSync();
  if (format === 'jpeg') return transformer.jpegSync(90);
  return transformer.webpSync(90);
}

export function toDataUrl(mime: string, buffer: Buffer): string {
  return `data:${mime};base64,${buffer.toString('base64')}`;
}

/**
 * Verified Qwen3-VL vision encoder geometry. Lives here rather than in one test file
 * because both tests/image-token-budget.test.ts and tests/image-admission.test.ts need it.
 * Task 8b is what gives it a consumer.
 */
export const INSTALLED_ENCODER = { hiddenSize: 1152, intermediateSize: 4304, patchesPerToken: 4 };

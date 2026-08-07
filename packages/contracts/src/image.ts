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

export const ImageDataUrlSchema = z.string().refine(
  (val) => {
    if (!val.startsWith('data:image/')) return false;
    const mimeMatch = val.match(/^data:(image\/\w+);base64,/);
    if (!mimeMatch) return false;
    if (!ImageMimeSchema.safeParse(mimeMatch[1]).success) return false;
    return base64PayloadByteLength(val.slice(mimeMatch[0].length)) <= SIFT_MAX_IMAGE_BYTES;
  },
  { message: 'supported-image' },
);
export type ImageDataUrl = z.infer<typeof ImageDataUrlSchema>;
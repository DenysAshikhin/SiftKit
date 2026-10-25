import { splitImageDataUrl, type ImageMime } from '@siftkit/contracts';

import type { Clock } from '../clock.ts';

const MS_PER_HOUR = 3_600_000;

/** The shell ships a 64-bit dHash; `PerceptualHashSchema` guarantees the 16 hex characters. */
const PERCEPTUAL_HASH_BITS = 64;

function hammingDistance(left: string, right: string): number {
  let difference = BigInt(`0x${left}`) ^ BigInt(`0x${right}`);
  let bits = 0;
  while (difference > 0n) {
    bits += Number(difference & 1n);
    difference >>= 1n;
  }
  return bits;
}

/** How alike two perceptual hashes are, as the percentage of matching bits. */
function perceptualSimilarityPercent(left: string, right: string): number {
  return (100 * (PERCEPTUAL_HASH_BITS - hammingDistance(left, right))) / PERCEPTUAL_HASH_BITS;
}

export function decodeCaptureImage(dataUrl: string): { mimeType: ImageMime; bytes: Buffer } {
  const split = splitImageDataUrl(dataUrl);
  if (split === null) {
    throw new Error('Capture image must be a base64 image data URL.');
  }
  const bytes = Buffer.from(split.base64, 'base64');
  if (bytes.byteLength === 0) {
    throw new Error('Capture image decoded to zero bytes.');
  }
  return { mimeType: split.mime, bytes };
}

/** Start of the dedupe window: captures older than the raw retention window no longer count. */
export function retentionWindowStartUtc(clock: Clock, retentionHours: number): string {
  return new Date(clock.nowEpochMs() - retentionHours * MS_PER_HOUR).toISOString();
}

/** Highest similarity of `hash` to any of `others`, or `null` when there are none. */
export function closestSimilarityPercent(hash: string, others: readonly string[]): number | null {
  return others.reduce<number | null>((closest, other) => {
    const percent = perceptualSimilarityPercent(hash, other);
    return closest === null || percent > closest ? percent : closest;
  }, null);
}

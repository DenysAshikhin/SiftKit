import test from 'node:test';
import assert from 'node:assert/strict';
import { computeImageTargetDimensions } from '@siftkit/contracts';

import {
  admitImageBuffer,
  admitImageDataUrl,
  admitImageDataUrls,
  downscaleImageBuffer,
  readImageDimensions,
} from '../src/llm-protocol/image-admission.js';
import { gifBufferWithSize, INSTALLED_ENCODER, rasterBuffer, toDataUrl } from './helpers/image-fixtures.js';

const MODEL_BUDGET = {
  maxPixels: 2_097_152,
  pixelsPerToken: 1024,
  maxImageTokens: 2048,
  encoder: INSTALLED_ENCODER,
  source: 'preprocessor_config' as const,
};

test('readImageDimensions reads PNG dimensions', () => {
  assert.deepEqual(
    readImageDimensions(rasterBuffer('png', 40, 25), 'image/png'),
    { width: 40, height: 25 },
  );
});

test('readImageDimensions reads JPEG dimensions', () => {
  assert.deepEqual(
    readImageDimensions(rasterBuffer('jpeg', 40, 25), 'image/jpeg'),
    { width: 40, height: 25 },
  );
});

test('readImageDimensions reads WebP dimensions', () => {
  assert.deepEqual(
    readImageDimensions(rasterBuffer('webp', 40, 25), 'image/webp'),
    { width: 40, height: 25 },
  );
});

test('readImageDimensions reads GIF dimensions from the header', () => {
  assert.deepEqual(
    readImageDimensions(gifBufferWithSize(1280, 720), 'image/gif'),
    { width: 1280, height: 720 },
  );
});

test('readImageDimensions throws on a truncated GIF header', () => {
  assert.throws(
    () => readImageDimensions(Buffer.alloc(6), 'image/gif'),
    /gif header/iu,
  );
});

test('readImageDimensions rejects GIF headers with zero dimensions', () => {
  assert.throws(
    () => readImageDimensions(gifBufferWithSize(0, 720), 'image/gif'),
    /gif dimensions must be positive/iu,
  );
  assert.throws(
    () => readImageDimensions(gifBufferWithSize(1280, 0), 'image/gif'),
    /gif dimensions must be positive/iu,
  );
});

test('computeImageTargetDimensions returns null when the image already fits', () => {
  assert.equal(computeImageTargetDimensions(800, 600, 1_000_000), null);
});

test('computeImageTargetDimensions scales to fit the pixel ceiling and preserves aspect ratio', () => {
  const target = computeImageTargetDimensions(4000, 2000, 1_000_000);
  assert.ok(target);
  assert.ok(target.width * target.height <= 1_000_000);
  // 2:1 stays 2:1 within a pixel of rounding.
  assert.ok(Math.abs(target.width / target.height - 2) < 0.01);
});

test('computeImageTargetDimensions never returns a zero dimension', () => {
  const target = computeImageTargetDimensions(10_000, 2, 100);
  assert.ok(target);
  assert.ok(target.width >= 1);
  assert.ok(target.height >= 1);
});

test('downscaleImageBuffer resizes a PNG to the target and keeps the format', () => {
  const source = rasterBuffer('png', 400, 200);
  const resized = downscaleImageBuffer(source, 'image/png', { width: 100, height: 50 });
  assert.deepEqual(readImageDimensions(resized, 'image/png'), { width: 100, height: 50 });
});

test('downscaleImageBuffer resizes JPEG and WebP and keeps each format', () => {
  for (const [format, mime] of [['jpeg', 'image/jpeg'], ['webp', 'image/webp']] as const) {
    const resized = downscaleImageBuffer(rasterBuffer(format, 400, 200), mime, { width: 100, height: 50 });
    assert.deepEqual(readImageDimensions(resized, mime), { width: 100, height: 50 }, mime);
  }
});

test('downscaleImageBuffer refuses GIF because the encoder cannot decode it', () => {
  assert.throws(
    () => downscaleImageBuffer(gifBufferWithSize(4000, 4000), 'image/gif', { width: 100, height: 100 }),
    /gif/iu,
  );
});

test('admitImageBuffer passes a within-budget image through untouched', () => {
  const source = rasterBuffer('png', 100, 100);
  const admitted = admitImageBuffer(source, 'image/png', { maxPixels: 1_000_000, pixelsPerToken: 784, maxImageTokens: 1275, encoder: INSTALLED_ENCODER, source: 'fallback' });

  assert.equal(admitted.metadata.width, 100);
  assert.equal(admitted.metadata.height, 100);
  assert.equal(admitted.metadata.originalWidth, 100);
  assert.equal(admitted.metadata.originalHeight, 100);
  assert.equal(admitted.metadata.resized, false);
  assert.equal(admitted.dataUrl.startsWith('data:image/png;base64,'), true);
});

test('admitted metadata never carries the image data, so persisting it cannot double storage', () => {
  const admitted = admitImageBuffer(rasterBuffer('png', 100, 100), 'image/png', { maxPixels: 1_000_000, pixelsPerToken: 784, maxImageTokens: 1275, encoder: INSTALLED_ENCODER, source: 'fallback' });

  assert.equal(JSON.stringify(admitted.metadata).includes('base64'), false);
});

test('admitImageBuffer downscales an over-ceiling image to within budget', () => {
  const source = rasterBuffer('png', 1000, 1000);
  const admitted = admitImageBuffer(source, 'image/png', { maxPixels: 10_000, pixelsPerToken: 784, maxImageTokens: 13, encoder: INSTALLED_ENCODER, source: 'fallback' });

  assert.ok(admitted.metadata.width * admitted.metadata.height <= 10_000);
  assert.equal(admitted.metadata.originalWidth, 1000);
  assert.equal(admitted.metadata.resized, true);
  assert.ok(admitted.metadata.tokenEstimate <= 13);
});

test('admitImageBuffer rejects an over-ceiling GIF with the resize message and real numbers', () => {
  assert.throws(
    () => admitImageBuffer(gifBufferWithSize(8000, 8000), 'image/gif', { maxPixels: 12_500_000, pixelsPerToken: 6104, maxImageTokens: 2048, encoder: INSTALLED_ENCODER, source: 'fallback' }),
    /image is 8000×8000 \(64\.0 MP\); this preset accepts up to 12\.5 MP \(≈2048 image tokens\) — resize and retry/u,
  );
});

test('admitImageBuffer admits a within-budget GIF', () => {
  const admitted = admitImageBuffer(gifBufferWithSize(100, 100), 'image/gif', { maxPixels: 1_000_000, pixelsPerToken: 784, maxImageTokens: 1275, encoder: INSTALLED_ENCODER, source: 'fallback' });
  assert.equal(admitted.metadata.width, 100);
  assert.equal(admitted.metadata.resized, false);
});

test('admitImageDataUrl round-trips through the data-URL form', () => {
  const url = toDataUrl('image/png', rasterBuffer('png', 60, 30));
  const admitted = admitImageDataUrl(url, { maxPixels: 1_000_000, pixelsPerToken: 784, maxImageTokens: 1275, encoder: INSTALLED_ENCODER, source: 'fallback' });
  assert.deepEqual([admitted.metadata.width, admitted.metadata.height], [60, 30]);
});

test('admitImageDataUrl rejects a non-image data URL', () => {
  assert.throws(() => admitImageDataUrl('data:text/plain;base64,aGk=', { maxPixels: 1_000_000, pixelsPerToken: 784, maxImageTokens: 1275, encoder: INSTALLED_ENCODER, source: 'fallback' }));
});

test('admitImageDataUrls admits every data URL with the shared budget and cap', () => {
  const urls = [toDataUrl('image/png', rasterBuffer('png', 2000, 1000))];
  const admitted = admitImageDataUrls(urls, MODEL_BUDGET, 500_000);

  assert.equal(admitted.length, 1);
  assert.ok((admitted[0]?.metadata.width ?? 0) * (admitted[0]?.metadata.height ?? 0) <= 500_000);
  assert.equal(admitted[0]?.metadata.resized, true);
});

test('admitImageDataUrls preserves within-model-ceiling data when the user cap is zero', () => {
  const url = toDataUrl('image/png', rasterBuffer('png', 1000, 1000));
  const admitted = admitImageDataUrls([url], MODEL_BUDGET, 0);

  assert.equal(admitted[0]?.dataUrl, url);
  assert.equal(admitted[0]?.metadata.resized, false);
});

test('admitImageDataUrls keeps malformed and oversized GIF errors explicit', () => {
  assert.throws(
    () => admitImageDataUrls(['https://example.com/image.png'], MODEL_BUDGET, 0),
    /supported-image/iu,
  );
  assert.throws(
    () => admitImageDataUrls([toDataUrl('image/gif', gifBufferWithSize(8000, 8000))], MODEL_BUDGET, 1_000_000),
    /this preset accepts up to 1\.0 MP/u,
  );
});

test('admitImageBuffer downscales to the user pixel cap, below the model ceiling', () => {
  // 2000x1000 is 2.0 MP — under the model's 2.1 MP — but over a 0.5 MP user cap.
  const admitted = admitImageBuffer(rasterBuffer('png', 2000, 1000), 'image/png', MODEL_BUDGET, 500_000);

  assert.ok(admitted.metadata.width * admitted.metadata.height <= 500_000);
  assert.equal(admitted.metadata.resized, true);
  assert.equal(admitted.metadata.originalWidth, 2000);
  // Aspect ratio survives the downscale.
  assert.ok(Math.abs(admitted.metadata.width / admitted.metadata.height - 2) < 0.01);
});

test('a cap of 0 leaves the model ceiling as the only limit', () => {
  const admitted = admitImageBuffer(rasterBuffer('png', 1000, 1000), 'image/png', MODEL_BUDGET, 0);
  assert.equal(admitted.metadata.resized, false);
});

test('a cap above the model ceiling cannot raise it', () => {
  const admitted = admitImageBuffer(rasterBuffer('png', 2000, 2000), 'image/png', MODEL_BUDGET, 99_000_000);

  assert.ok(admitted.metadata.width * admitted.metadata.height <= 2_097_152);
  assert.equal(admitted.metadata.resized, true);
});

test('two images of equal area but different shape cost the same tokens', () => {
  // 4000x500 and 2500x800 are both exactly 2 MP. A pixel cap prices them identically; an edge
  // cap would not. This is the regression that pins the field's unit.
  const wide = admitImageBuffer(rasterBuffer('png', 4000, 500), 'image/png', MODEL_BUDGET, 1_000_000);
  const square = admitImageBuffer(rasterBuffer('png', 2500, 800), 'image/png', MODEL_BUDGET, 1_000_000);

  assert.equal(wide.metadata.tokenEstimate, square.metadata.tokenEstimate);
});

test('an oversized GIF names the effective ceiling, not the raw model ceiling', () => {
  assert.throws(
    () => admitImageBuffer(gifBufferWithSize(8000, 8000), 'image/gif', MODEL_BUDGET, 1_000_000),
    /this preset accepts up to 1\.0 MP/u,
  );
});

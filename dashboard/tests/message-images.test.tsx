import './react-test-environment.js';

import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import React, { act } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ImageMetadataSchema, computeImageTargetDimensions } from '@siftkit/contracts';

import { PendingImageStrip } from '../src/components/PendingImageStrip';
import { MessageImages } from '../src/components/MessageImages';
import {
  downscaleDataUrl,
} from '../src/lib/downscale-image';
import { readImageFile } from '../src/tabs/ChatTab';
import { fireEvent, render, screen } from './react-test-environment.js';

const SMALL_PNG = 'data:image/png;base64,AA==';
const LARGE_PNG = 'data:image/png;base64,AQ==';
const GIF = 'data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=';
const PNG_A = 'data:image/png;base64,AA==';
const PNG_B = 'data:image/png;base64,AQ==';
const META = ImageMetadataSchema.parse({
  width: 1440,
  height: 900,
  originalWidth: 1440,
  originalHeight: 900,
  mime: 'image/png',
  byteLength: 421_888,
  tokenEstimate: 1024,
  resized: false,
  caption: null,
});

function renderImages(images: string[], imageMeta = [META]): string {
  return renderToStaticMarkup(
    <MessageImages sessionId="s1" messageId="m1" images={images} imageMeta={imageMeta} />,
  );
}

const originalFetch = globalThis.fetch;
const originalFileReader = globalThis.FileReader;

function installBrowserStubs(width: number, height: number, contextAvailable = true): void {
  Object.defineProperty(globalThis, 'fetch', {
    configurable: true,
    value: async () => new Response(new Uint8Array([1]), {
      headers: { 'content-type': 'image/png' },
    }),
  });
  Object.defineProperty(globalThis, 'createImageBitmap', {
    configurable: true,
    value: async () => ({ width, height, close: () => undefined }),
  });
  Object.defineProperty(globalThis, 'OffscreenCanvas', {
    configurable: true,
    value: class {
      getContext(): { drawImage(): void } | null {
        return contextAvailable ? { drawImage: () => undefined } : null;
      }

      async convertToBlob(options: { type: string }): Promise<Blob> {
        return new Blob([new Uint8Array([2])], { type: options.type });
      }
    },
  });
}

afterEach(() => {
  Object.defineProperty(globalThis, 'fetch', { configurable: true, value: originalFetch });
  Object.defineProperty(globalThis, 'FileReader', { configurable: true, value: originalFileReader });
  Reflect.deleteProperty(globalThis, 'createImageBitmap');
  Reflect.deleteProperty(globalThis, 'OffscreenCanvas');
});

test('computeImageTargetDimensions is shared by browser and server admission', () => {
  assert.equal(computeImageTargetDimensions(800, 600, 1_000_000), null);
  const target = computeImageTargetDimensions(4000, 2000, 1_000_000);
  assert.ok(target);
  assert.ok(target.width * target.height <= 1_000_000);
});

test('downscaleDataUrl leaves a within-budget image untouched and reports no resize', async () => {
  installBrowserStubs(800, 600);
  const result = await downscaleDataUrl(SMALL_PNG, 1_000_000);
  assert.equal(result.dataUrl, SMALL_PNG);
  assert.equal(result.note, null);
});

test('downscaleDataUrl reports original and final dimensions when it resizes', async () => {
  installBrowserStubs(4000, 2000);
  const result = await downscaleDataUrl(LARGE_PNG, 1_000);
  assert.notEqual(result.dataUrl, LARGE_PNG);
  assert.match(result.note ?? '', /^Resized from \d+×\d+ to \d+×\d+$/u);
});

test('downscaleDataUrl converts an oversized GIF first frame to PNG', async () => {
  installBrowserStubs(4000, 2000);
  const result = await downscaleDataUrl(GIF, 1_000);
  assert.match(result.dataUrl, /^data:image\/png;base64,/u);
  assert.match(result.note ?? '', /GIF frame one converted to PNG/u);
});

test('downscaleDataUrl rejects invalid data URLs before browser decoding', async () => {
  await assert.rejects(() => downscaleDataUrl('data:image/svg+xml;base64,AA==', 1_000));
});

test('downscaleDataUrl reports unavailable canvas context', async () => {
  installBrowserStubs(4000, 2000, false);
  await assert.rejects(
    () => downscaleDataUrl(LARGE_PNG, 1_000),
    /2d canvas context could not be created/u,
  );
});

test('readImageFile downsizes before returning the value for pending-image change', async () => {
  installBrowserStubs(4000, 2000);
  Object.defineProperty(globalThis, 'FileReader', {
    configurable: true,
    value: class {
      result: string | null = null;
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;

      readAsDataURL(): void {
        this.result = LARGE_PNG;
        this.onload?.();
      }
    },
  });
  const result = await readImageFile(new File([new Uint8Array([1])], 'large.png', { type: 'image/png' }), 1_000);
  assert.notEqual(result.dataUrl, LARGE_PNG);
  assert.match(result.note ?? '', /^Resized from \d+×\d+ to \d+×\d+$/u);
});

test('PendingImageStrip renders the note for the resized image index', () => {
  const markup = renderToStaticMarkup(
    <PendingImageStrip
      images={[
        { dataUrl: SMALL_PNG, note: null },
        { dataUrl: LARGE_PNG, note: 'Resized from 4000×2000 to 22×11' },
      ]}
      onChange={() => undefined}
    />,
  );
  assert.match(markup, /title="Resized from 4000×2000 to 22×11"/u);
});

test('renders each image inline in the bubble', () => {
  assert.equal((renderImages([PNG_A, PNG_B], [META, META]).match(/<img\b/gu) ?? []).length, 2);
});

test('the annotation is collapsed and shows dimensions, format, size and tokens', () => {
  const html = renderImages([PNG_A]);
  assert.match(html, /1440.*900.*png.*412 KB.*1,024 tok/u);
  assert.doesNotMatch(html, /<details[^>]*\sopen(?:=|\s|>)/u);
});

test('a user message with no metadata still renders the image', () => {
  assert.equal((renderImages([PNG_A], []).match(/<img\b/gu) ?? []).length, 1);
});

test('renders nothing when the message has no images', () => {
  assert.equal(renderImages([], []), '');
});

test('uses a persisted caption without requesting it', { concurrency: false }, async () => {
  let fetchCalls = 0;
  Object.defineProperty(globalThis, 'fetch', {
    configurable: true,
    value: async () => {
      fetchCalls += 1;
      return new Response(JSON.stringify({ caption: 'unexpected request' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
  });
  render(
    <MessageImages
      sessionId="s1"
      messageId="m1"
      images={[PNG_A]}
      imageMeta={[{ ...META, caption: 'persisted caption' }]}
    />,
  );

  await act(async () => {
    fireEvent.click(screen.getByText(/1440/u));
    await new Promise<void>((resolve) => { setImmediate(resolve); });
  });

  assert.equal(fetchCalls, 0);
  assert.match(screen.getByText('persisted caption').textContent ?? '', /persisted caption/u);
});

test('deduplicates caption requests while one request is pending', { concurrency: false }, async () => {
  let resolveResponse: ((response: Response) => void) | null = null;
  let fetchCalls = 0;
  const responsePromise = new Promise<Response>((resolve) => { resolveResponse = resolve; });
  Object.defineProperty(globalThis, 'fetch', {
    configurable: true,
    value: async () => {
      fetchCalls += 1;
      return responsePromise;
    },
  });
  render(<MessageImages sessionId="s1" messageId="m1" images={[PNG_A]} imageMeta={[META]} />);
  const summary = screen.getByText(/1440/u);

  await act(async () => {
    fireEvent.click(summary);
    await new Promise<void>((resolve) => { setImmediate(resolve); });
  });
  const details = screen.getByRole('group');
  await act(async () => {
    fireEvent(details, new window.Event('toggle'));
    await Promise.resolve();
  });
  assert.equal(fetchCalls, 1);

  resolveResponse?.(new Response(JSON.stringify({ caption: 'fetched caption' }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  }));
  assert.match((await screen.findByText('fetched caption')).textContent ?? '', /fetched caption/u);
});

test('shows a caption error without an unhandled rejection', { concurrency: false }, async () => {
  Object.defineProperty(globalThis, 'fetch', {
    configurable: true,
    value: async () => { throw new Error('caption service unavailable'); },
  });
  render(<MessageImages sessionId="s1" messageId="m1" images={[PNG_A]} imageMeta={[META]} />);
  await act(async () => {
    fireEvent.click(screen.getByText(/1440/u));
    await new Promise<void>((resolve) => { setImmediate(resolve); });
  });
  assert.match((await screen.findByRole('alert')).textContent ?? '', /caption service unavailable/u);
});

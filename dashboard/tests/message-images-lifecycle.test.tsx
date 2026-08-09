import './react-test-environment.js';

import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import React, { act } from 'react';
import { ImageMetadataSchema } from '@siftkit/contracts';

import { fireEvent, render } from './react-test-environment.js';
import { MessageImages } from '../src/components/MessageImages.js';

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

const originalFetch = globalThis.fetch;

afterEach(() => {
  Object.defineProperty(globalThis, 'fetch', { configurable: true, value: originalFetch });
});

function deferredFetch(): { responses: Array<(response: Response) => void>; fetch: () => Promise<Response> } {
  const responses: Array<(response: Response) => void> = [];
  return {
    responses,
    fetch: async () => new Promise<Response>((resolve) => { responses.push(resolve); }),
  };
}

async function openDetails(view: ReturnType<typeof render>): Promise<void> {
  await act(async () => {
    const details = view.container.querySelector('details');
    if (!details) {
      throw new Error('image annotation was not rendered');
    }
    details.open = true;
    fireEvent(details, new window.Event('toggle'));
    await new Promise<void>((resolve) => { setImmediate(resolve); });
  });
}

function KeyedMessageImages(props: React.ComponentProps<typeof MessageImages>): React.JSX.Element {
  return <MessageImages key={`${props.sessionId}:${props.messageId}`} {...props} />;
}

test('guards in-flight caption requests across identity changes and unmounts', async () => {
  const deferred = deferredFetch();
  Object.defineProperty(globalThis, 'fetch', { configurable: true, value: deferred.fetch });
  const view = render(<KeyedMessageImages sessionId="s1" messageId="m1" images={[PNG_A]} imageMeta={[META]} />);

  await openDetails(view);
  assert.equal(deferred.responses.length, 1);

  view.rerender(<KeyedMessageImages sessionId="s2" messageId="m2" images={[PNG_B]} imageMeta={[META]} />);
  await openDetails(view);
  assert.equal(deferred.responses.length, 2);

  await act(async () => {
    deferred.responses[0]?.(new Response(JSON.stringify({ caption: 'old caption' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    await Promise.resolve();
  });
  assert.doesNotMatch(view.container.textContent ?? '', /old caption/u);
  assert.match(view.container.textContent ?? '', /Reading the image/u);

  await act(async () => {
    deferred.responses[1]?.(new Response(JSON.stringify({ caption: 'new caption' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    await Promise.resolve();
  });
  assert.match(view.container.textContent ?? '', /new caption/u);

  view.rerender(<KeyedMessageImages sessionId="s3" messageId="m3" images={[PNG_A]} imageMeta={[META]} />);
  await openDetails(view);
  assert.equal(deferred.responses.length, 3);
  view.rerender(<KeyedMessageImages sessionId="s4" messageId="m4" images={[PNG_B]} imageMeta={[META]} />);
  await openDetails(view);
  assert.equal(deferred.responses.length, 4);

  await act(async () => {
    deferred.responses[2]?.(new Response('old failure', { status: 500 }));
    await Promise.resolve();
  });
  assert.doesNotMatch(view.container.textContent ?? '', /old failure/u);
  assert.match(view.container.textContent ?? '', /Reading the image/u);

  await act(async () => {
    deferred.responses[3]?.(new Response(JSON.stringify({ caption: 'new caption after error' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    await Promise.resolve();
  });
  assert.match(view.container.textContent ?? '', /new caption after error/u);

  view.rerender(<KeyedMessageImages sessionId="s5" messageId="m5" images={[PNG_A]} imageMeta={[META]} />);
  await openDetails(view);
  assert.equal(deferred.responses.length, 5);
  view.unmount();
  await act(async () => {
    deferred.responses[4]?.(new Response(JSON.stringify({ caption: 'after unmount' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    await Promise.resolve();
  });
  assert.equal(view.container.textContent, '');
});

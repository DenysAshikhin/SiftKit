import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useSmoothedText } from '../src/hooks/useSmoothedText';

type Harness = {
  container: HTMLElement;
  root: Root;
  /** Advances the fake clock to `atMs` and runs the frame callbacks queued before it, as a display refresh would. */
  frameAt(atMs: number): Promise<void>;
  setNow(atMs: number): void;
  pendingFrames(): number;
  cancelledFrames(): number;
  teardown(): Promise<void>;
};

function replaceGlobal(key: PropertyKey, value: object | boolean): () => void {
  const original = Object.getOwnPropertyDescriptor(globalThis, key);
  Object.defineProperty(globalThis, key, { configurable: true, value, writable: true });
  return () => {
    if (original) {
      Object.defineProperty(globalThis, key, original);
      return;
    }
    Reflect.deleteProperty(globalThis, key);
  };
}

/** Only now() is faked: React's dev build also uses the other performance methods. */
function overrideClock(now: () => number): () => void {
  Object.defineProperty(performance, 'now', { configurable: true, value: now, writable: true });
  return () => { Reflect.deleteProperty(performance, 'now'); };
}

function setup(): Harness {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>');
  const container = dom.window.document.getElementById('root');
  if (!container) {
    throw new Error('Hook test root was not created.');
  }
  let now = 0;
  let nextFrameId = 1;
  let cancelled = 0;
  const frames = new Map<number, FrameRequestCallback>();
  const restores = [
    replaceGlobal('window', dom.window),
    replaceGlobal('document', dom.window.document),
    replaceGlobal('navigator', dom.window.navigator),
    replaceGlobal('IS_REACT_ACT_ENVIRONMENT', true),
    overrideClock(() => now),
    replaceGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      const id = nextFrameId;
      nextFrameId += 1;
      frames.set(id, callback);
      return id;
    }),
    replaceGlobal('cancelAnimationFrame', (id: number) => {
      if (frames.delete(id)) cancelled += 1;
    }),
  ];
  const root = createRoot(container);
  return {
    container,
    root,
    frameAt: async (atMs) => {
      now = atMs;
      const due = [...frames.entries()];
      frames.clear();
      await act(async () => {
        for (const [, callback] of due) callback(atMs);
      });
    },
    setNow: (atMs) => { now = atMs; },
    pendingFrames: () => frames.size,
    cancelledFrames: () => cancelled,
    teardown: async () => {
      await act(async () => root.unmount());
      for (const restore of restores.reverse()) restore();
      dom.window.close();
    },
  };
}

function SmoothedTextHarness({ text, live }: { text: string; live: boolean }) {
  return <div data-testid="output">{useSmoothedText(text, live)}</div>;
}

function readOutput(container: HTMLElement): string {
  return container.querySelector('[data-testid="output"]')?.textContent ?? '';
}

async function render(harness: Harness, text: string, live: boolean): Promise<void> {
  await act(async () => {
    harness.root.render(<SmoothedTextHarness text={text} live={live} />);
  });
}

test('initial mount renders the complete existing text without scheduling a frame', async () => {
  const harness = setup();
  try {
    await render(harness, 'hello world', true);
    assert.equal(readOutput(harness.container), 'hello world');
    assert.equal(harness.pendingFrames(), 0);
  } finally {
    await harness.teardown();
  }
});

test('a larger live rerender keeps its prefix and grows on each display frame until caught up', async () => {
  const harness = setup();
  try {
    await render(harness, 'abc', true);
    await render(harness, 'abcdefghijklmnop', true);
    assert.equal(readOutput(harness.container), 'abc');
    const lengths: number[] = [];
    for (let atMs = 16; harness.pendingFrames() > 0; atMs += 16) {
      await harness.frameAt(atMs);
      lengths.push(readOutput(harness.container).length);
    }
    assert.equal(readOutput(harness.container), 'abcdefghijklmnop');
    assert.equal(lengths.every((length, index) => index === 0 || length > (lengths[index - 1] ?? 0)), true, `lengths ${lengths.join(',')}`);
  } finally {
    await harness.teardown();
  }
});

test('updates arriving faster than the display keep the text advancing on every frame', async () => {
  const harness = setup();
  try {
    let text = 'abc';
    await render(harness, text, true);
    const lengths: number[] = [];
    // A token every 10 ms against a 60 Hz display: the frame loop must survive every update.
    for (let atMs = 10; atMs <= 400; atMs += 10) {
      harness.setNow(atMs);
      text += 'defg';
      await render(harness, text, true);
      if (atMs % 20 === 0) {
        await harness.frameAt(atMs);
        lengths.push(readOutput(harness.container).length);
      }
    }
    assert.equal(text.startsWith(readOutput(harness.container)), true);
    assert.equal(lengths.every((length, index) => index === 0 || length > (lengths[index - 1] ?? 0)), true, `lengths ${lengths.join(',')}`);
  } finally {
    await harness.teardown();
  }
});

test('display frames closer together than the advance interval are skipped', async () => {
  const harness = setup();
  try {
    await render(harness, '', true);
    await render(harness, 'x'.repeat(400), true);
    const outputs: string[] = [];
    // A 144 Hz display (~7 ms frames) advances on roughly every other frame.
    for (let atMs = 7; atMs <= 140; atMs += 7) {
      await harness.frameAt(atMs);
      outputs.push(readOutput(harness.container));
    }
    const advances = outputs.filter((output, index) => output !== (outputs[index - 1] ?? '')).length;
    assert.equal(advances, 10);
  } finally {
    await harness.teardown();
  }
});

test('switching live off snaps to the complete text and cancels the pending frame', async () => {
  const harness = setup();
  try {
    await render(harness, 'abc', true);
    await render(harness, 'abcdef', true);
    assert.equal(harness.pendingFrames(), 1);

    await render(harness, 'abcdef', false);

    assert.equal(readOutput(harness.container), 'abcdef');
    assert.equal(harness.pendingFrames(), 0);
    assert.equal(harness.cancelledFrames(), 1);
  } finally {
    await harness.teardown();
  }
});

test('unmounting while behind cancels its pending frame', async () => {
  const harness = setup();
  try {
    await render(harness, 'abc', true);
    await render(harness, 'abcdef', true);
    assert.equal(harness.pendingFrames(), 1);

    await act(async () => harness.root.render(<></>));

    assert.equal(harness.pendingFrames(), 0);
    assert.equal(harness.cancelledFrames(), 1);
  } finally {
    await harness.teardown();
  }
});

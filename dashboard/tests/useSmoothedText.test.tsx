import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useSmoothedText } from '../src/hooks/useSmoothedText';

type DomHarness = {
  container: HTMLElement;
  teardown: () => void;
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

function setupDom(): DomHarness {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>');
  const container = dom.window.document.getElementById('root');
  if (!container) {
    throw new Error('Hook test root was not created.');
  }
  const restoreWindow = replaceGlobal('window', dom.window);
  const restoreDocument = replaceGlobal('document', dom.window.document);
  const restoreNavigator = replaceGlobal('navigator', dom.window.navigator);
  const restoreActEnvironment = replaceGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  return {
    container,
    teardown: () => {
      restoreActEnvironment();
      restoreNavigator();
      restoreDocument();
      restoreWindow();
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

async function render(root: Root, text: string, live: boolean): Promise<void> {
  await act(async () => {
    root.render(<SmoothedTextHarness text={text} live={live} />);
  });
}

test('initial mount renders the complete existing text', async () => {
  const dom = setupDom();
  const root = createRoot(dom.container);
  try {
    await render(root, 'hello world', true);
    assert.equal(readOutput(dom.container), 'hello world');
  } finally {
    await act(async () => root.unmount());
    dom.teardown();
  }
});

test('a larger live rerender retains its prefix and advances after a timer', async () => {
  const dom = setupDom();
  const root = createRoot(dom.container);
  try {
    await render(root, 'abc', true);
    await render(root, 'abcdef', true);
    assert.equal(readOutput(dom.container), 'abc');

    await act(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
    });
    const advanced = readOutput(dom.container);
    assert.equal(advanced.length > 3, true);
    assert.equal('abcdef'.startsWith(advanced), true);
  } finally {
    await act(async () => root.unmount());
    dom.teardown();
  }
});

test('switching live off snaps to complete text and cancels the pending timer', async () => {
  const dom = setupDom();
  const root = createRoot(dom.container);
  const originalClearTimeout = globalThis.clearTimeout;
  let clearCount = 0;
  const trackingClearTimeout: typeof globalThis.clearTimeout = (timer) => {
    clearCount += 1;
    originalClearTimeout(timer);
  };
  const restoreClearTimeout = replaceGlobal('clearTimeout', trackingClearTimeout);
  try {
    await render(root, 'abc', true);
    await render(root, 'abcdef', true);
    const beforeSnap = clearCount;

    await render(root, 'abcdef', false);

    assert.equal(readOutput(dom.container), 'abcdef');
    assert.equal(clearCount > beforeSnap, true);
  } finally {
    await act(async () => root.unmount());
    restoreClearTimeout();
    dom.teardown();
  }
});

test('unmounting while behind cancels its pending timer', async () => {
  const dom = setupDom();
  const root = createRoot(dom.container);
  const originalClearTimeout = globalThis.clearTimeout;
  let clearCount = 0;
  const trackingClearTimeout: typeof globalThis.clearTimeout = (timer) => {
    clearCount += 1;
    originalClearTimeout(timer);
  };
  const restoreClearTimeout = replaceGlobal('clearTimeout', trackingClearTimeout);
  let unmounted = false;
  try {
    await render(root, 'abc', true);
    await render(root, 'abcdef', true);
    const beforeUnmount = clearCount;

    await act(async () => root.unmount());
    unmounted = true;

    assert.equal(clearCount > beforeUnmount, true);
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    assert.equal(dom.container.textContent, '');
  } finally {
    if (!unmounted) {
      await act(async () => root.unmount());
    }
    restoreClearTimeout();
    dom.teardown();
  }
});

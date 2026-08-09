import { afterEach } from 'node:test';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: dom.window.navigator });
Object.assign(globalThis, {
  window: dom.window,
  document: dom.window.document,
  HTMLElement: dom.window.HTMLElement,
  HTMLButtonElement: dom.window.HTMLButtonElement,
  IS_REACT_ACT_ENVIRONMENT: true,
});

const testingLibrary = await import('@testing-library/react');

export const render = testingLibrary.render;
export const screen = testingLibrary.screen;
export const fireEvent = testingLibrary.fireEvent;
export const cleanup = testingLibrary.cleanup;

afterEach(() => cleanup());

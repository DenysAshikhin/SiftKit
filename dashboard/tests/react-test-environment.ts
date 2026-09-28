import './render-tracker.js';
import { afterEach } from 'node:test';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/', pretendToBeVisual: true });
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: dom.window.navigator });

const resizeListeners = new Set<() => void>();

/** jsdom has no layout; tests call notifyResize() where a browser would report a size change. */
class TestResizeObserver {
  private readonly notify: () => void;
  constructor(callback: ResizeObserverCallback) { this.notify = () => callback([], this); }
  observe(): void { resizeListeners.add(this.notify); }
  unobserve(): void {}
  disconnect(): void { resizeListeners.delete(this.notify); }
}

export function notifyResize(): void {
  for (const notify of resizeListeners) notify();
}

Object.assign(globalThis, {
  ResizeObserver: TestResizeObserver,
  window: dom.window,
  document: dom.window.document,
  HTMLElement: dom.window.HTMLElement,
  HTMLButtonElement: dom.window.HTMLButtonElement,
  Event: dom.window.Event,
  requestAnimationFrame: dom.window.requestAnimationFrame,
  cancelAnimationFrame: dom.window.cancelAnimationFrame,
  IS_REACT_ACT_ENVIRONMENT: true,
});

const testingLibrary = await import('@testing-library/react');

export const render = testingLibrary.render;
export const screen = testingLibrary.screen;
export const fireEvent = testingLibrary.fireEvent;
export const renderHook = testingLibrary.renderHook;
export const waitFor = testingLibrary.waitFor;
export const cleanup = testingLibrary.cleanup;

afterEach(() => cleanup());

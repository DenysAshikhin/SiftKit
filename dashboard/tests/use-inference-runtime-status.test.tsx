import './react-test-environment.js';

import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act } from 'react';
import { render, screen } from './react-test-environment.js';
import { useInferenceRuntimeStatus } from '../src/hooks/useInferenceRuntimeStatus.js';

const STATUS = {
  activePresetId: 'active-id',
  activePresetLabel: 'Active runtime',
  backend: 'llama',
  idleAction: 'unload',
  processState: 'ready',
  modelState: 'ready',
  model: 'active-model',
  idleDeadlineUtc: null,
  errorPhase: null,
  error: null,
  rollback: null,
  imageTokenBudget: null,
  gpuFreeBytes: null,
};

function Probe(): React.JSX.Element {
  const runtime = useInferenceRuntimeStatus();
  return <output>{runtime.loading ? 'loading' : runtime.error ?? runtime.status?.activePresetId ?? 'empty'}</output>;
}

test('polling waits two seconds after each settled request without overlap', async () => {
  const originalFetch = globalThis.fetch;
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  const callbacks: Array<{ delay: number; callback: () => void }> = [];
  let activeRequests = 0;
  let maxActiveRequests = 0;
  Object.defineProperty(globalThis, 'setTimeout', {
    configurable: true,
    value: (callback: TimerHandler, delay?: number): number => {
      if (typeof callback !== 'function') throw new Error('Expected a callback timer.');
      callbacks.push({ callback: () => callback(), delay: delay ?? 0 });
      return callbacks.length;
    },
  });
  Object.defineProperty(globalThis, 'clearTimeout', { configurable: true, value: () => {} });
  globalThis.fetch = async () => {
    activeRequests += 1;
    maxActiveRequests = Math.max(maxActiveRequests, activeRequests);
    activeRequests -= 1;
    return new Response(JSON.stringify(STATUS), { status: 200 });
  };
  try {
    render(<Probe />);
    await act(async () => {});
    assert.equal(callbacks.length, 1);
    assert.equal(callbacks[0]?.delay, 2000);
    await act(async () => { callbacks.shift()?.callback(); });
    assert.equal(callbacks.length, 1);
    assert.equal(callbacks[0]?.delay, 2000);
    assert.equal(maxActiveRequests, 1);
  } finally {
    globalThis.fetch = originalFetch;
    Object.defineProperty(globalThis, 'setTimeout', { configurable: true, value: originalSetTimeout });
    Object.defineProperty(globalThis, 'clearTimeout', { configurable: true, value: originalClearTimeout });
  }
});

test('unmount aborts an active status request', async () => {
  const originalFetch = globalThis.fetch;
  let wasAborted = false;
  let resolveFetch: (response: Response) => void = () => {};
  globalThis.fetch = async (_input, init) => {
    init?.signal?.addEventListener('abort', () => { wasAborted = true; });
    return new Promise<Response>((resolve) => { resolveFetch = resolve; });
  };
  try {
    const mounted = render(<Probe />);
    await act(async () => {});
    mounted.unmount();
    assert.equal(wasAborted, true);
    resolveFetch(new Response(JSON.stringify(STATUS), { status: 200 }));
    await act(async () => {});
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('a stale response from an unmounted request cannot replace a newer runtime status', async () => {
  const originalFetch = globalThis.fetch;
  let callCount = 0;
  let resolveFirst: (response: Response) => void = () => {};
  globalThis.fetch = async () => {
    callCount += 1;
    if (callCount === 1) {
      return new Promise<Response>((resolve) => { resolveFirst = resolve; });
    }
    return new Response(JSON.stringify(STATUS), { status: 200 });
  };
  try {
    const first = render(<Probe />);
    await act(async () => {});
    first.unmount();
    render(<Probe />);
    await act(async () => {});
    assert.equal(screen.getByText('active-id').textContent, 'active-id');
    resolveFirst(new Response(JSON.stringify({ ...STATUS, activePresetId: 'stale-id' }), { status: 200 }));
    await act(async () => {});
    assert.equal(screen.getByText('active-id').textContent, 'active-id');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

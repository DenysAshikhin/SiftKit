import './react-test-environment.js';

import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act } from 'react';
import { fireEvent, render, screen } from './react-test-environment.js';
import { ModelRuntimeResidencyPanel } from '../src/tabs/settings/ModelRuntimeResidencyPanel.js';
import { useInferenceRuntimeStatus } from '../src/hooks/useInferenceRuntimeStatus.js';

const STATUS = {
  activePresetId: 'active-id',
  activePresetLabel: 'Active runtime',
  backend: 'exl3',
  idleAction: 'freeze',
  freezeSupported: true,
  processState: 'ready',
  modelState: 'ready',
  model: 'active-model',
  idleDeadlineUtc: '2026-08-10T12:00:00.000Z',
  errorPhase: null,
  error: null,
  rollback: null,
  imageTokenBudget: null,
  gpuFreeBytes: 1024,
};

function installFetch(status: typeof STATUS = STATUS): { calls: string[]; restore(): void } {
  const originalFetch = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = async (input) => {
    const url = String(input);
    calls.push(url);
    if (url === '/runtime/inference') return new Response(JSON.stringify(status), { status: 200 });
    return new Response(JSON.stringify({ ok: true, status: 'done' }), { status: 200 });
  };
  return { calls, restore: () => { globalThis.fetch = originalFetch; } };
}

function RuntimePanel(): React.JSX.Element {
  const runtime = useInferenceRuntimeStatus();
  return <ModelRuntimeResidencyPanel runtime={runtime} />;
}

test('renders active runtime identity independently of selected preset editor', async () => {
  const fetchState = installFetch();
  try {
    render(<RuntimePanel />);
    await act(async () => {});
    assert.match(screen.getByRole('region', { name: 'Active model runtime' }).textContent ?? '', /Active runtime/);
    assert.match(screen.getByRole('region', { name: 'Active model runtime' }).textContent ?? '', /active-id/);
    assert.match(screen.getByRole('region', { name: 'Active model runtime' }).textContent ?? '', /active-model/);
    assert.equal(screen.queryByText('Offload'), null);
    assert.equal(fetchState.calls[0], '/runtime/inference');
  } finally {
    fetchState.restore();
  }
});

test('renders static runtime facts as associated definition terms and descriptions', async () => {
  const fetchState = installFetch();
  try {
    render(<RuntimePanel />);
    await act(async () => {});
    const terms = screen.getAllByRole('term').map((term) => term.textContent);
    const definitions = screen.getAllByRole('definition').map((definition) => definition.textContent);
    assert.equal(terms.includes('Active preset'), true);
    assert.equal(definitions.includes('Active runtime'), true);
  } finally {
    fetchState.restore();
  }
});

test('freeze control uses the exact route and refetches status after completion', async () => {
  const fetchState = installFetch();
  try {
    render(<RuntimePanel />);
    await act(async () => {});
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Freeze to RAM' })); });
    assert.deepEqual(fetchState.calls.slice(0, 3), [
      '/runtime/inference',
      '/runtime/model/freeze',
      '/runtime/inference',
    ]);
  } finally {
    fetchState.restore();
  }
});

test('load and unload controls follow stable state and backend rules', async () => {
  const fetchState = installFetch({ ...STATUS, modelState: 'frozen' });
  try {
    render(<RuntimePanel />);
    await act(async () => {});
    assert.equal(screen.getByRole('button', { name: 'Load/Restore' }).hasAttribute('disabled'), false);
    assert.equal(screen.getByRole('button', { name: 'Freeze to RAM' }).hasAttribute('disabled'), true);
    assert.equal(screen.getByRole('button', { name: 'Unload' }).hasAttribute('disabled'), false);
  } finally {
    fetchState.restore();
  }
});

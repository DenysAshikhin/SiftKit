import { test } from 'vitest';
import assert from 'node:assert/strict';
import React from 'react';
import { SiftConfigSchema } from '@siftkit/contracts';

import { useSettingsController } from '../src/hooks/useSettingsController.ts';
import { SettingsTab } from '../src/tabs/SettingsTab.tsx';
import { DASHBOARD_CONFIG } from './fixtures.ts';
import { fireEvent, render, screen, waitFor } from './react-test-environment.ts';

function SettingsHarness() {
  const controller = useSettingsController({
    tab: 'settings', webSearchUsage: null, webSearchQuota: null,
    enqueueToast() {}, requestDashboardDataRefresh() {}, onSwitchTab() {},
  });
  return <SettingsTab {...controller.tabProps} />;
}

test('General CPU threads edits, saves, reloads, handles rejected saves, and clears through the controller', async () => {
  const originalFetch = globalThis.fetch;
  let savedConfig = SiftConfigSchema.parse(DASHBOARD_CONFIG);
  globalThis.fetch = async (input, init) => {
    if (input === '/config?skip_ready=1') return Response.json(savedConfig);
    if (input === '/config' && init?.method === 'PUT' && typeof init.body === 'string') {
      const result = SiftConfigSchema.safeParse(JSON.parse(init.body));
      if (!result.success) return Response.json({ error: result.error.message }, { status: 400 });
      savedConfig = result.data;
      return Response.json(savedConfig);
    }
    throw new Error(`Unexpected settings request: ${String(input)}`);
  };
  const view = render(<SettingsHarness />);
  async function waitUntilReady() {
    await waitFor(() => assert.equal(screen.getByRole('button', { name: 'Save settings' }).hasAttribute('disabled'), false));
  }
  async function waitUntilSaved() {
    await waitFor(() => assert.equal(screen.queryByText(/[Uu]nsaved/u) === null, true));
    await waitUntilReady();
  }
  try {
    const input = await screen.findByRole('spinbutton', { name: 'Tabby/EXL3 CPU threads' });
    await waitUntilReady();
    if (!(input instanceof window.HTMLInputElement)) throw new Error('Expected a numeric input');
    assert.equal(input.value, '');
    assert.equal(input.placeholder, 'Automatic');
    assert.equal(input.min, '1');
    assert.equal(input.step, '1');

    fireEvent.change(input, { target: { value: '8' } });
    assert.ok(screen.getByText(/[Uu]nsaved/u));
    fireEvent.click(screen.getByRole('button', { name: 'Save settings' }));
    await waitUntilSaved();
    fireEvent.click(screen.getByRole('button', { name: 'Reload' }));
    await waitUntilReady();
    assert.equal(input.value, '8');

    fireEvent.change(input, { target: { value: '0' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save settings' }));
    await screen.findByText(/CPU threads must be a positive integer/u);
    assert.equal(input.value, '0');
    assert.ok(screen.getByText(/[Uu]nsaved/u));
    fireEvent.change(input, { target: { value: '8' } });
    fireEvent.click(screen.getByRole('button', { name: 'Reload' }));
    await waitUntilReady();
    assert.equal(input.value, '8');

    fireEvent.change(input, { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save settings' }));
    await waitUntilSaved();
    fireEvent.click(screen.getByRole('button', { name: 'Reload' }));
    await waitUntilReady();
    assert.equal(input.value, '');
    assert.ok(screen.getByRole('button', { name: 'Restart backend' }));
  } finally {
    view.unmount();
    globalThis.fetch = originalFetch;
  }
});

import { test } from 'vitest';
import assert from 'node:assert/strict';
import React from 'react';
import type { AssistantConfig } from '../../src/config/types.ts';
import { DEFAULT_ASSISTANT_CONFIG } from '../../src/config/defaults.ts';
import { AssistantSettings } from '../src/tabs/settings/AssistantSettings.tsx';
import { fireEvent, render, screen } from './react-test-environment.ts';

function json(value: object): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function desktopStateBody(capable: boolean, queueDepth: number): object {
  return {
    schemaVersion: 1,
    assistantEnabled: true,
    captureEnabled: false,
    paused: false,
    custody: { custody: 'file', imported: false, activeKeyId: null },
    imageCapability: {
      capable, instanceId: capable ? 'exl3:1' : null, queueDepth,
    },
    pendingQuestion: null,
  };
}

/** Serves the settings view's startup requests; `routes` adds or overrides individual paths. */
function stubFetch(options: { capable?: boolean; queueDepth?: number; routes?: Record<string, () => Response> } = {}): string[] {
  const calls: string[] = [];
  Object.defineProperty(globalThis, 'fetch', {
    configurable: true,
    value: async (input: string) => {
      calls.push(input);
      const route = options.routes?.[input];
      if (route !== undefined) return route();
      if (input === '/assistant/auth/bootstrap') return json({ token: 'session-secret' });
      if (input === '/assistant/desktop/state') return json(desktopStateBody(options.capable ?? true, options.queueDepth ?? 0));
      if (input === '/assistant/background-decisions') return json({ items: [] });
      if (input === '/assistant/captures/pending') return json({ captures: [] });
      throw new Error(`Unexpected request: ${input}`);
    },
  });
  return calls;
}

test('the settings views are configuration and pending captures only', async () => {
  const calls = stubFetch();
  render(<AssistantSettings assistant={DEFAULT_ASSISTANT_CONFIG} onChange={() => {}} />);
  await screen.findByText('No background-work blocks have been recorded.');
  const nav = screen.getByLabelText('Assistant settings view');
  assert.deepEqual([...nav.querySelectorAll('button')].map((button) => button.textContent), ['Configuration', 'Pending captures']);
  assert.ok(!calls.some((url) => /validation|history/u.test(url)), 'retired endpoints are never called');
});

test('configuration edits retrieval, vault and job priority settings of the slimmed config', async () => {
  stubFetch();
  const changes: AssistantConfig[] = [];
  render(<AssistantSettings assistant={DEFAULT_ASSISTANT_CONFIG} onChange={(value) => changes.push(value)} />);

  fireEvent.change(screen.getByLabelText(/Max notes/u), { target: { value: '5' } });
  assert.equal(changes.at(-1)?.Retrieval.MaxNotes, 5);
  const tidy = screen.getByRole('checkbox', { name: /Tidy pass/u });
  fireEvent.click(tidy);
  assert.equal(changes.at(-1)?.Vault.TidyPassEnabled, !DEFAULT_ASSISTANT_CONFIG.Vault.TidyPassEnabled);
  fireEvent.change(screen.getByLabelText(/Capture image max age days/u), { target: { value: '30' } });
  assert.equal(changes.at(-1)?.Vault.CaptureImageMaxAgeDays, 30);
  fireEvent.change(screen.getByLabelText(/Chat note priority/u), { target: { value: '900' } });
  assert.equal(changes.at(-1)?.Background.JobPriorities.ChatNote, 900);
  for (const label of [/Capture note priority/u, /Daily rollup priority/u, /Note tidy priority/u, /Capture retention priority/u]) {
    screen.getByLabelText(label);
  }
  assert.equal(screen.queryByText(/Memory budgets|Questions enabled|Max hops/u), null, 'graph-era settings are gone');
  await screen.findByText('No background-work blocks have been recorded.');
});

test('observation settings render consent, capture controls, deny lists, and the capability warning', async () => {
  stubFetch({ capable: false, queueDepth: 3 });
  const changes: AssistantConfig[] = [];
  render(
    <AssistantSettings
      assistant={DEFAULT_ASSISTANT_CONFIG}
      onChange={(value) => changes.push(value)}
    />,
  );

  const screenshots = screen.getByRole('checkbox', { name: /^Screenshots/u });
  assert.ok(screenshots instanceof window.HTMLInputElement);
  assert.equal(screenshots.checked, false, 'screenshots default off');
  screen.getByText(/enables automatic image analysis/u);

  const scope = screen.getByLabelText(/Capture scope/u);
  assert.ok(scope instanceof window.HTMLSelectElement);
  assert.equal(scope.value, 'foreground_window');
  fireEvent.change(scope, { target: { value: 'all_monitors' } });
  assert.equal(changes.at(-1)?.Observation.CaptureScope, 'all_monitors');

  screen.getByLabelText(/Fixed cadence seconds/u);
  screen.getByLabelText(/Duplicate similarity percent/u);
  screen.getByLabelText(/Minimum foreground dwell seconds/u);
  screen.getByLabelText(/Raw retention hours/u);
  screen.getByLabelText(/Raw storage limit GB/u);

  const processes = screen.getByLabelText(/Process deny list/u);
  fireEvent.change(processes, { target: { value: ' obs64.exe \n\nkeepass.exe' } });
  assert.deepEqual(
    changes.at(-1)?.Observation.ProcessDenyList, ['obs64.exe', 'keepass.exe'],
  );

  const titles = screen.getByLabelText(/Title deny patterns/u);
  fireEvent.change(titles, { target: { value: '.*bank.*' } });
  assert.deepEqual(changes.at(-1)?.Observation.TitleDenyPatterns, ['.*bank.*']);

  const startup = screen.getByRole('checkbox', { name: /Start SiftKit Assistant when I sign in/u });
  assert.ok(startup instanceof window.HTMLInputElement);
  assert.equal(startup.checked, false, 'sign-in startup defaults off');
  fireEvent.click(startup);
  assert.equal(changes.at(-1)?.Observation.StartOnSignIn, true);

  await screen.findByText(/Key custody: local file key/u);
  await screen.findByText(/No vision-capable model is active/u);
  await screen.findByText(/3 captures are waiting for image analysis/u);
  await screen.findByText('No background-work blocks have been recorded.');
});

test('deny-list fields resync when the config changes from outside', async () => {
  stubFetch();
  const { rerender } = render(
    <AssistantSettings assistant={DEFAULT_ASSISTANT_CONFIG} onChange={() => {}} />,
  );
  const processes = screen.getByLabelText(/Process deny list/u);
  assert.ok(processes instanceof window.HTMLTextAreaElement);
  assert.equal(processes.value, '');

  const loaded: AssistantConfig = {
    ...DEFAULT_ASSISTANT_CONFIG,
    Observation: {
      ...DEFAULT_ASSISTANT_CONFIG.Observation,
      ProcessDenyList: ['obs64.exe', 'keepass.exe'],
    },
  };
  rerender(<AssistantSettings assistant={loaded} onChange={() => {}} />);
  assert.equal(
    processes.value, 'obs64.exe\nkeepass.exe',
    'an externally loaded config must reach the textarea',
  );

  // Mid-edit the raw draft wins — normalization must not fight the caret …
  fireEvent.change(processes, { target: { value: 'obs64.exe\nkeepass.exe\n ' } });
  assert.equal(processes.value, 'obs64.exe\nkeepass.exe\n ');
  // … and blur reconciles the display back to the stored values.
  fireEvent.blur(processes);
  assert.equal(processes.value, 'obs64.exe\nkeepass.exe');
});

test('pending captures list vault captures with attachment previews and a lightbox', async () => {
  const created: string[] = [];
  Object.defineProperty(window.URL, 'createObjectURL', {
    configurable: true,
    value: () => {
      const url = `blob:capture-${created.length + 1}`;
      created.push(url);
      return url;
    },
  });
  Object.defineProperty(window.URL, 'revokeObjectURL', { configurable: true, value: () => {} });
  stubFetch({ queueDepth: 1, routes: {
    '/assistant/captures/pending': () => json({ captures: [{
      attachmentId: 'att_1', noteId: 'note_1', noteTitle: '2026-08-10 10.00.00 · Code', state: 'awaiting_image_capability',
      capturedAtUtc: '2026-08-10T10:00:00.000Z', byteLength: 68, relativePath: 'captures/att_1.png',
    }] }),
    '/assistant/vault/attachments/captures/att_1.png': () => new Response(
      new Blob([Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])], { type: 'image/png' }),
    ),
  } });

  render(<AssistantSettings assistant={DEFAULT_ASSISTANT_CONFIG} onChange={() => {}} />);
  fireEvent.click(screen.getByRole('button', { name: 'Pending captures' }));

  const image = await screen.findByRole('img');
  assert.equal(image.getAttribute('src'), 'blob:capture-1', 'the thumbnail uses an object URL');
  assert.deepEqual(created, ['blob:capture-1'], 'one object URL is created per capture');
  screen.getByText('awaiting image capability');
  screen.getByText('2026-08-10 10.00.00 · Code');
  screen.getByText(`${new Date('2026-08-10T10:00:00.000Z').toLocaleString()} · 0.1 KB`);

  fireEvent.click(screen.getByRole('button', { name: 'Enlarge capture 2026-08-10 10.00.00 · Code' }));
  screen.getByRole('dialog');
  assert.equal(screen.getAllByRole('img').length, 2, 'the lightbox shows the same preview');
});

test('configuration shows persisted background-work decisions newest-first', async () => {
  stubFetch({ queueDepth: 2, routes: {
    '/assistant/background-decisions': () => json({ items: [
      {
        recordedAtUtc: '2026-08-31T12:01:00.000Z',
        reason: 'mouse_idle_below_threshold',
        queuedJobCount: 29,
        pendingCaptureCount: 941,
        details: { mouseIdleSeconds: 12, requiredIdleSeconds: 180 },
      },
      {
        recordedAtUtc: '2026-08-31T12:00:00.000Z',
        reason: 'server_busy',
        queuedJobCount: 28,
        pendingCaptureCount: 940,
        details: {},
      },
    ] }),
  } });

  render(<AssistantSettings assistant={DEFAULT_ASSISTANT_CONFIG} onChange={() => {}} />);

  await screen.findByText('Background work decisions');
  const decisions = screen.getAllByRole('article');
  assert.match(decisions[0]?.textContent ?? '', /Mouse idle below threshold/u);
  assert.match(decisions[1]?.textContent ?? '', /Server busy/u);
  screen.getByText(/29 queued jobs/u);
  screen.getByText(/941 pending captures/u);
  screen.getByText(/mouseIdleSeconds: 12/u);
  screen.getByText(/requiredIdleSeconds: 180/u);
});

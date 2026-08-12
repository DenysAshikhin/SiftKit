import test from 'node:test';
import assert from 'node:assert/strict';
import React, { act } from 'react';
import type { AssistantConfig } from '../../src/config/types.js';
import { DEFAULT_ASSISTANT_CONFIG } from '../../src/config/defaults.js';
import { AssistantSettings } from '../src/tabs/settings/AssistantSettings.js';
import { fireEvent, render, screen } from './react-test-environment.js';

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

test('loads pending proof and memory history and saves notes with its in-memory token', { concurrency: false }, async () => {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  Object.defineProperty(globalThis, 'fetch', {
    configurable: true,
    value: async (input: string, init?: RequestInit) => {
      calls.push({ url: input, init });
      if (input === '/assistant/auth/bootstrap') return json({ token: 'session-secret' });
      if (input === '/assistant/desktop/state') return json(desktopStateBody(true, 0));
      if (input === '/assistant/validation') return json({ items: [{
        id: 'candidate-1', status: 'pending', proposedStatement: 'Prefers concise answers',
        rationale: 'Repeated explicit requests', confidence: 0.82, sensitivity: 'personal',
        evidenceId: 'evidence-1', userNotes: '', createdAtUtc: '2026-08-10T10:00:00.000Z',
      }] });
      if (input === '/assistant/history') return json({ items: [{
        id: 'mutation-1', operation: 'add', targetType: 'assertion', targetId: 'assertion-1',
        summary: 'Added “Prefers concise answers”', reason: 'Validated candidate',
        proofs: [{ evidenceId: 'evidence-1', sourceType: 'conversation', sourceRef: 'chat-1' }],
        createdAtUtc: '2026-08-10T10:01:00.000Z',
      }] });
      if (input.endsWith('/notes')) return json({ ok: true, graphVersion: 1 });
      throw new Error(`Unexpected request: ${input}`);
    },
  });

  render(<AssistantSettings assistant={DEFAULT_ASSISTANT_CONFIG} onChange={() => {}} />);
  fireEvent.click(screen.getByRole('button', { name: 'Pending validation' }));
  await screen.findByText('Prefers concise answers');
  fireEvent.click(screen.getByRole('button', { name: 'Memory history' }));
  await screen.findByText(/Added “Prefers concise answers”/u);
  fireEvent.click(screen.getByRole('button', { name: 'Pending validation' }));
  const notes = await screen.findByLabelText('Notes for Prefers concise answers');
  fireEvent.change(notes, { target: { value: 'Keep this scoped to writing style.' } });
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Save notes' }));
    await new Promise<void>((resolve) => { setImmediate(resolve); });
  });

  const noteCall = calls.find((call) => call.url.endsWith('/notes'));
  assert.equal(noteCall?.init?.method, 'PATCH');
  assert.deepEqual(noteCall?.init?.headers, {
    Authorization: 'Bearer session-secret',
    'Content-Type': 'application/json',
  });
  assert.equal(window.sessionStorage.length, 0);
  assert.equal(window.localStorage.length, 0);
});

test('observation settings render consent, capture controls, deny lists, and the capability warning', { concurrency: false }, async () => {
  Object.defineProperty(globalThis, 'fetch', {
    configurable: true,
    value: async (input: string) => {
      if (input === '/assistant/auth/bootstrap') return json({ token: 'session-secret' });
      if (input === '/assistant/desktop/state') return json(desktopStateBody(false, 3));
      if (input === '/assistant/validation') return json({ items: [] });
      if (input === '/assistant/history') return json({ items: [] });
      throw new Error(`Unexpected request: ${input}`);
    },
  });
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
});

test('deny-list fields resync when the config changes from outside', { concurrency: false }, async () => {
  Object.defineProperty(globalThis, 'fetch', {
    configurable: true,
    value: async (input: string) => {
      if (input === '/assistant/auth/bootstrap') return json({ token: 'session-secret' });
      if (input === '/assistant/desktop/state') return json(desktopStateBody(true, 0));
      if (input === '/assistant/validation') return json({ items: [] });
      if (input === '/assistant/history') return json({ items: [] });
      throw new Error(`Unexpected request: ${input}`);
    },
  });
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

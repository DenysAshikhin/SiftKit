import test from 'node:test';
import assert from 'node:assert/strict';
import React, { act } from 'react';
import { DEFAULT_ASSISTANT_CONFIG } from '../../src/config/defaults.js';
import { AssistantSettings } from '../src/tabs/settings/AssistantSettings.js';
import { fireEvent, render, screen } from './react-test-environment.js';

function json(value: object): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

test('loads pending proof and memory history and saves notes with its in-memory token', { concurrency: false }, async () => {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  Object.defineProperty(globalThis, 'fetch', {
    configurable: true,
    value: async (input: string, init?: RequestInit) => {
      calls.push({ url: input, init });
      if (input === '/assistant/auth/bootstrap') return json({ token: 'session-secret' });
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

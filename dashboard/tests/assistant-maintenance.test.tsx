import test from 'node:test';
import assert from 'node:assert/strict';
import React, { act } from 'react';
import { AssistantMaintenance } from '../src/tabs/settings/AssistantMaintenance.js';
import { fireEvent, render, screen } from './react-test-environment.js';

const TOKEN = 'session-secret';
const ARCHIVE = Uint8Array.from([0x50, 0x4b, 0x03, 0x04]);

type Call = { url: string; init: RequestInit | undefined };

function json(value: object): Response {
  return new Response(JSON.stringify(value), {
    status: 200, headers: { 'content-type': 'application/json' },
  });
}

function zip(): Response {
  return new Response(ARCHIVE, { status: 200, headers: { 'content-type': 'application/zip' } });
}

/** Counts object URLs so a leaked download blob fails loudly, as the Gate D reveal does. */
function trackObjectUrls(): { created: string[]; revoked: string[] } {
  const created: string[] = [];
  const revoked: string[] = [];
  Object.defineProperty(window.URL, 'createObjectURL', {
    configurable: true,
    value: () => {
      const url = `blob:archive-${created.length + 1}`;
      created.push(url);
      return url;
    },
  });
  Object.defineProperty(window.URL, 'revokeObjectURL', {
    configurable: true,
    value: (url: string) => { revoked.push(url); },
  });
  return { created, revoked };
}

function stubFetch(handler: (input: string, init: RequestInit | undefined) => Response): Call[] {
  const calls: Call[] = [];
  Object.defineProperty(globalThis, 'fetch', {
    configurable: true,
    value: async (input: string, init?: RequestInit) => {
      calls.push({ url: input, init });
      return handler(input, init);
    },
  });
  return calls;
}

async function settle(action: () => void): Promise<void> {
  await act(async () => {
    action();
    await new Promise<void>((resolve) => { setImmediate(resolve); });
  });
}

test('export and backup download their archives and revoke every object URL', { concurrency: false }, async () => {
  const urls = trackObjectUrls();
  const calls = stubFetch((input) => {
    if (input === '/assistant/export' || input === '/assistant/backup') return zip();
    throw new Error(`Unexpected request: ${input}`);
  });

  render(<AssistantMaintenance token={TOKEN} />);
  fireEvent.click(screen.getByRole('checkbox', { name: 'Include decrypted evidence blobs' }));
  await settle(() => fireEvent.click(screen.getByRole('button', { name: 'Export memory' })));

  const exportCall = calls.find((call) => call.url === '/assistant/export');
  assert.equal(exportCall?.init?.method, 'POST');
  assert.equal(exportCall?.init?.body, JSON.stringify({ includeDecryptedBlobs: true }));
  assert.deepEqual(urls.created, ['blob:archive-1']);
  assert.deepEqual(urls.revoked, ['blob:archive-1'], 'the download URL is revoked immediately');

  await settle(() => fireEvent.click(screen.getByRole('button', { name: 'Create backup' })));
  const backupCall = calls.find((call) => call.url === '/assistant/backup');
  assert.equal(backupCall?.init?.method, 'POST');
  assert.deepEqual(urls.created, ['blob:archive-1', 'blob:archive-2']);
  assert.deepEqual(urls.revoked, ['blob:archive-1', 'blob:archive-2']);
});

test('restore previews the uploaded archive and never hides unreadable blobs', { concurrency: false }, async () => {
  trackObjectUrls();
  const calls = stubFetch((input) => {
    if (input === '/assistant/restore-preview') {
      return json({
        uploadId: 'upl_1', confirmToken: 'cft_1', schemaVersion: 44,
        custody: 'desktop', fileCount: 7, totalBytes: 4096,
      });
    }
    if (input === '/assistant/restore') {
      return json({
        ok: true, blobsReadable: false,
        warning: 'Blobs were sealed on another machine.',
      });
    }
    throw new Error(`Unexpected request: ${input}`);
  });

  render(<AssistantMaintenance token={TOKEN} />);
  assert.equal(screen.queryByRole('button', { name: 'Confirm restore' }), null);

  const input = screen.getByLabelText('Backup archive to restore');
  const file = new window.File([ARCHIVE], 'backup.zip', { type: 'application/zip' });
  await settle(() => fireEvent.change(input, { target: { files: [file] } }));

  const previewCall = calls.find((call) => call.url === '/assistant/restore-preview');
  assert.equal(previewCall?.init?.method, 'POST');
  await screen.findByText(/7 files/u);
  await screen.findByText(/schema version 44/u);

  await settle(() => fireEvent.click(screen.getByRole('button', { name: 'Confirm restore' })));
  const restoreCall = calls.find((call) => call.url === '/assistant/restore');
  assert.equal(restoreCall?.init?.body, JSON.stringify({
    uploadId: 'upl_1', confirmToken: 'cft_1',
  }));
  await screen.findByText('Blobs were sealed on another machine.');
});

test('factory reset stays disabled until the exact phrase is typed over a live preview', { concurrency: false }, async () => {
  trackObjectUrls();
  const calls = stubFetch((input) => {
    if (input === '/assistant/factory-reset/preview') {
      return json({
        previewToken: 'pre_reset', graphVersion: 6,
        tableCounts: { assistant_assertions: 12 }, blobCount: 3, blobBytes: 2048,
      });
    }
    if (input === '/assistant/factory-reset') return json({ ok: true });
    throw new Error(`Unexpected request: ${input}`);
  });

  render(<AssistantMaintenance token={TOKEN} />);
  const phrase = screen.getByLabelText('Type RESET ASSISTANT to enable the reset button');
  const reset = screen.getByRole('button', { name: 'Reset assistant' });
  assert.ok(reset instanceof window.HTMLButtonElement);
  assert.equal(reset.disabled, true, 'no preview and no phrase');

  fireEvent.change(phrase, { target: { value: 'RESET ASSISTANT' } });
  assert.equal(reset.disabled, true, 'the phrase alone never enables a reset');

  await settle(() => fireEvent.click(screen.getByRole('button', { name: 'Preview factory reset' })));
  await screen.findByText(/3 evidence blobs/u);
  assert.equal(reset.disabled, false);

  fireEvent.change(phrase, { target: { value: 'reset assistant' } });
  assert.equal(reset.disabled, true, 'the phrase is compared exactly');

  fireEvent.change(phrase, { target: { value: 'RESET ASSISTANT' } });
  await settle(() => fireEvent.click(reset));
  const confirmCall = calls.find((call) => call.url === '/assistant/factory-reset');
  assert.equal(confirmCall?.init?.body, JSON.stringify({ previewToken: 'pre_reset' }));
});

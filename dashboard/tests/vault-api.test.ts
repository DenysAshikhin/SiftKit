import { afterEach, test } from 'vitest';
import assert from 'node:assert/strict';

import {
  getVaultGraph, getVaultNote, updateVaultNote, VaultRequestError,
} from '../src/vault-api.ts';

const NOTE = {
  id: 'vnote_1', title: 'a b', folder: '', kind: 'note', types: [], aliases: [], tags: [], body: 'x',
  revision: 2, isStub: false, createdAtUtc: '2026-10-24T09:00:00.000Z', updatedAtUtc: '2026-10-24T09:00:00.000Z',
} as const;
const originalFetch = globalThis.fetch;
const calls: { url: string; init: RequestInit | undefined }[] = [];

function stubFetch(status: number, body: object): void {
  calls.length = 0;
  globalThis.fetch = async (input, init) => {
    calls.push({ url: String(input), init });
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  };
}

afterEach(() => {
  globalThis.fetch = originalFetch;
});

test('getVaultNote encodes the id, sends the bearer token and parses the detail', async () => {
  stubFetch(200, { note: NOTE, backlinks: [], outgoing: { resolved: [], unresolved: ['x'] } });
  const detail = await getVaultNote('tok', 'a b');
  assert.equal(calls[0]?.url, '/assistant/vault/notes/a%20b');
  assert.deepEqual(calls[0]?.init?.headers, { Authorization: 'Bearer tok' });
  assert.equal(detail.note.revision, 2);
  assert.deepEqual(detail.outgoing.unresolved, ['x']);
});

test('updateVaultNote sends a JSON PUT with the expected revision', async () => {
  stubFetch(200, { ...NOTE, revision: 3 });
  const note = await updateVaultNote('tok', 'vnote_1', { body: 'y' }, 2);
  assert.equal(calls[0]?.init?.method, 'PUT');
  assert.equal(calls[0]?.init?.body, JSON.stringify({ body: 'y', expectedRevision: 2 }));
  assert.equal(note.revision, 3);
});

test('a 409 conflict throws a VaultRequestError carrying status and code', async () => {
  stubFetch(409, { error: { code: 'conflict', message: 'Note changed.', currentRevision: 3 } });
  await assert.rejects(updateVaultNote('tok', 'vnote_1', { body: 'y' }, 2), (error: Error) => {
    assert.ok(error instanceof VaultRequestError);
    assert.equal(error.status, 409);
    assert.equal(error.code, 'conflict');
    assert.equal(error.message, 'Note changed.');
    return true;
  });
});

test('an unparseable error body keeps a status-only message', async () => {
  stubFetch(500, { nope: true });
  await assert.rejects(getVaultGraph('tok'), /Vault request failed \(500\)/);
});

test('getVaultGraph requests the unfiltered graph', async () => {
  stubFetch(200, { nodes: [], edges: [] });
  assert.deepEqual(await getVaultGraph('tok'), { nodes: [], edges: [] });
  assert.equal(calls[0]?.url, '/assistant/vault/graph');
});

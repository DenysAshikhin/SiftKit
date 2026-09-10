import test from 'node:test';
import assert from 'node:assert/strict';
import { GatedChatBackend } from './helpers/gated-chat-backend.js';

test('gated backend rejects unknown routes and wrong methods', async (t) => {
  const backend = new GatedChatBackend();
  t.after(() => backend.close());
  const baseUrl = await backend.start();
  assert.equal((await fetch(`${baseUrl}/misspelled`)).status, 404);
  assert.equal((await fetch(`${baseUrl}/v1/chat/completions`)).status, 405);
  assert.equal((await fetch(`${baseUrl}/v1/token/encode`)).status, 405);
  assert.equal((await fetch(`${baseUrl}/v1/models`, { method: 'POST' })).status, 405);
});

test('closing the backend rejects a pending provider gate and future gates', async () => {
  const backend = new GatedChatBackend();
  await backend.start();
  const outcome = backend.nextRequest().then(() => 'request', () => 'closed');
  await backend.close();
  assert.equal(await Promise.race([outcome, Promise.resolve('pending')]), 'closed');
  await assert.rejects(backend.nextRequest(), /closed/u);
});

test('cleanup is safe before startup and on repeated calls', async () => {
  const backend = new GatedChatBackend();
  await backend.close();
  await backend.close();
});

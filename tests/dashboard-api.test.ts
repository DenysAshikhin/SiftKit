import test from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { parseJsonResponse } from '../dashboard/src/api.js';

test('parseJsonResponse validates against the schema', async () => {
  const out = await parseJsonResponse(new Response(JSON.stringify({ ok: true })), z.object({ ok: z.boolean() }));
  assert.deepEqual(out, { ok: true });
});
test('parseJsonResponse throws on schema mismatch', async () => {
  await assert.rejects(() => parseJsonResponse(new Response(JSON.stringify({ ok: 'no' })), z.object({ ok: z.boolean() })));
});
test('parseJsonResponse throws on non-ok status', async () => {
  await assert.rejects(() => parseJsonResponse(new Response('boom', { status: 500 }), z.object({ ok: z.boolean() })));
});

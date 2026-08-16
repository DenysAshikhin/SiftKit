import assert from 'node:assert/strict';
import test from 'node:test';

import { getInferenceRuntimeStatus, postModelResidencyAction } from '../src/api.js';

const STATUS = {
  activePresetId: 'active-id',
  activePresetLabel: 'Active runtime',
  backend: 'exl3',
  idleAction: 'freeze',
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

test('lifecycle action posts freeze and parses its shared response', async () => {
  const originalFetch = globalThis.fetch;
  let requestUrl = '';
  globalThis.fetch = async (input) => {
    requestUrl = String(input);
    return new Response(JSON.stringify({ ok: true, status: 'done' }), { status: 200 });
  };
  try {
    assert.deepEqual(await postModelResidencyAction('freeze'), { ok: true, status: 'done' });
    assert.equal(requestUrl, '/runtime/model/freeze');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('lifecycle action rejects a schema-invalid response', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ ok: true, status: 'bad' }), { status: 200 });
  try {
    await assert.rejects(() => postModelResidencyAction('load'));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('runtime status forwards an abort signal and validates the shared status schema', async () => {
  const originalFetch = globalThis.fetch;
  const controller = new AbortController();
  let receivedSignal: AbortSignal | null = null;
  globalThis.fetch = async (_input, init) => {
    receivedSignal = init?.signal ?? null;
    return new Response(JSON.stringify(STATUS), { status: 200 });
  };
  try {
    assert.deepEqual(await getInferenceRuntimeStatus({ signal: controller.signal }), STATUS);
    assert.equal(receivedSignal, controller.signal);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

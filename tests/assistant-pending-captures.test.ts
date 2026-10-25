import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
  PENDING_CAPTURE_LIST_STATES, PendingCaptureDtoSchema, PendingCapturesResponseSchema,
} from '@siftkit/contracts';
import { getDefaultConfig } from '../src/status-server/config-store.ts';
import { VAULT_CAPTURE_STATES } from '../src/vault/captures.ts';
import { requestJson } from './helpers/dashboard-http.ts';
import {
  CAPTURE_PNG_BYTES, captureSubmissionDto, withAssistantServer,
} from './helpers/assistant-server-harness.ts';

test('pending captures route lists waiting vault captures whose PNG the attachment route serves', async () => {
  const initial = getDefaultConfig();
  await withAssistantServer('siftkit-pending-captures-', {
    ...initial.Assistant,
    Enabled: true,
    Observation: { ...initial.Assistant.Observation, ScreenshotsEnabled: true },
  }, async ({ baseUrl, headers }) => {
    const empty = await requestJson(`${baseUrl}/assistant/captures/pending`, { headers });
    assert.equal(empty.statusCode, 200);
    assert.deepEqual(PendingCapturesResponseSchema.parse(empty.body), { captures: [] });

    const ingested = await requestJson(`${baseUrl}/assistant/ingest/capture`, {
      method: 'POST', headers, body: JSON.stringify(captureSubmissionDto('a', 'f'.repeat(16))),
    });
    assert.equal(ingested.statusCode, 200);

    const listed = await requestJson(`${baseUrl}/assistant/captures/pending`, { headers });
    assert.equal(listed.statusCode, 200);
    const { captures } = PendingCapturesResponseSchema.parse(listed.body);
    assert.equal(captures.length, 1);
    const capture = captures[0];
    assert.ok(capture);
    assert.equal(capture.state, 'awaiting_image_capability');
    assert.match(capture.noteTitle, / · Code$/, 'the app falls back to the process name');
    assert.equal(capture.byteLength, CAPTURE_PNG_BYTES.byteLength);
    assert.equal(capture.relativePath, `captures/${capture.attachmentId}.png`);

    const file = await fetch(`${baseUrl}/assistant/vault/attachments/${capture.relativePath}`, { headers });
    assert.equal(file.status, 200);
    assert.equal(file.headers.get('content-type'), 'image/png');
    assert.deepEqual(Buffer.from(await file.arrayBuffer()), CAPTURE_PNG_BYTES);
  });
});

test('pending-capture list states have exactly one source of truth', () => {
  assert.deepEqual(PendingCaptureDtoSchema.shape.state.options, [...PENDING_CAPTURE_LIST_STATES]);
  assert.deepEqual(VAULT_CAPTURE_STATES.slice(0, PENDING_CAPTURE_LIST_STATES.length), [...PENDING_CAPTURE_LIST_STATES]);
  const capturesSource = fs.readFileSync(path.join('src', 'vault', 'captures.ts'), 'utf8');
  assert.doesNotMatch(capturesSource, /'queued', 'awaiting_image_capability', 'processing'/u);
});

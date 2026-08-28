import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
  PENDING_CAPTURE_LIST_STATES, PendingCaptureDtoSchema, PendingCapturesResponseSchema,
} from '@siftkit/contracts';
import { getDefaultConfig } from '../src/status-server/config-store.js';
import { requestJson } from './helpers/dashboard-http.js';
import {
  CAPTURE_PNG_BYTES, captureSubmissionDto, withAssistantServer,
} from './helpers/assistant-server-harness.js';

test('pending captures route lists queued captures whose pixels the evidence route serves', async () => {
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
    assert.ok(['queued', 'awaiting_image_capability', 'processing'].includes(capture.state));
    assert.equal(capture.foregroundContextKey, 'app:code|siftkit');
    assert.equal(capture.byteLength, CAPTURE_PNG_BYTES.byteLength);
    assert.ok(capture.enqueuedAtUtc.length > 0);

    const blob = await fetch(`${baseUrl}/assistant/evidence/blob?id=${encodeURIComponent(capture.evidenceId)}`, {
      headers,
    });
    assert.equal(blob.status, 200);
    assert.equal(blob.headers.get('content-type'), 'image/png');
    assert.deepEqual(Buffer.from(await blob.arrayBuffer()), CAPTURE_PNG_BYTES);
  });
});

test('pending-capture list states have exactly one source of truth', () => {
  assert.deepEqual(PendingCaptureDtoSchema.shape.state.options, [...PENDING_CAPTURE_LIST_STATES]);

  const serviceSource = fs.readFileSync(path.join('src', 'assistant', 'assistant-service.ts'), 'utf8');
  assert.match(serviceSource, /PENDING_CAPTURE_LIST_STATES/u);
  assert.doesNotMatch(serviceSource, /'queued', 'awaiting_image_capability', 'processing'/u);
  assert.match(serviceSource, /PENDING_CAPTURE_LIST_LIMIT/u);
});

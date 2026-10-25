import assert from 'node:assert/strict';
import test from 'node:test';

import {
  AssistantConfigPatchRequestSchema,
  AssistantErrorResponseSchema,
  AssistantFactoryResetPreviewSchema,
  AssistantRestoreResultSchema,
  AssistantStatusResponseSchema,
  PENDING_CAPTURE_LIST_STATES,
  PENDING_CAPTURE_STATES,
  PendingCaptureDtoSchema,
} from '@siftkit/contracts';
import { DEFAULT_ASSISTANT_CONFIG } from '../src/config/defaults.ts';

const PENDING_CAPTURE = {
  attachmentId: 'att_1', noteId: 'note_1', noteTitle: '2026-10-24 09.00.00 · Code', state: 'queued',
  capturedAtUtc: '2026-10-24T09:00:00.000Z', byteLength: 68, relativePath: 'captures/att_1.png',
};

test('assistant public contracts round-trip representative valid DTOs', () => {
  const examples = [
    [AssistantStatusResponseSchema, { available: true, enabled: false, ownerId: 'own_local' }],
    [AssistantConfigPatchRequestSchema, { assistant: DEFAULT_ASSISTANT_CONFIG }],
    [PendingCaptureDtoSchema, PENDING_CAPTURE],
    [AssistantFactoryResetPreviewSchema, { previewToken: 'signed', graphVersion: 4, tableCounts: { graph_nodes: 2 }, blobCount: 1, blobBytes: 68 }],
    [AssistantRestoreResultSchema, { ok: true, blobsReadable: false, warning: 'Blobs could not be unsealed.' }],
    [AssistantErrorResponseSchema, { error: { code: 'not_found', message: 'Missing' } }],
    [AssistantErrorResponseSchema, { error: { code: 'conflict', message: 'Stale', currentRevision: 2 } }],
  ] as const;
  for (const [schema, value] of examples) {
    assert.deepEqual(schema.parse(value), value);
  }
});

test('assistant public contracts reject malformed and unknown fields', () => {
  assert.equal(AssistantStatusResponseSchema.safeParse({ available: true }).success, false);
  assert.equal(AssistantStatusResponseSchema.safeParse({
    available: true, enabled: true, ownerId: 'own_local', pendingQuestionCount: 0,
  }).success, false, 'the retired question count is no longer part of the status');
  assert.equal(AssistantConfigPatchRequestSchema.safeParse({
    assistant: DEFAULT_ASSISTANT_CONFIG,
    unknown: true,
  }).success, false);
  assert.equal(PendingCaptureDtoSchema.safeParse({ ...PENDING_CAPTURE, state: 'processed' }).success, false);
  assert.equal(PendingCaptureDtoSchema.safeParse({ ...PENDING_CAPTURE, evidenceId: 'ev_1' }).success, false);
});

test('the pending view lists exactly the drain states plus the in-flight one', () => {
  assert.deepEqual([...PENDING_CAPTURE_LIST_STATES], [...PENDING_CAPTURE_STATES, 'processing']);
});

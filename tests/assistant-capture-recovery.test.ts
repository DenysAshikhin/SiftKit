import test from 'node:test';
import assert from 'node:assert/strict';

import { CaptureQueueStore } from '../src/assistant/images/capture-queue-store.js';
import { withAssistantContext } from './helpers/assistant-fixture.js';

const CAPTURED_AT = '2026-08-10T14:03:11.000Z';

function enqueueCapture(
  queue: CaptureQueueStore, ownerId: string, evidenceId: string, pixel: string,
): void {
  queue.enqueue({
    ownerId, evidenceId, state: 'queued', foregroundContextKey: 'app:code',
    pixelSha256: pixel, perceptualHash: 'f0e1d2c3b4a59687', byteLength: 1024,
  });
}

/**
 * `ImageExtractor.run` marks a capture `processing` before the model call. A crash, restart, or
 * abort before `markProcessed` used to strand it forever: `PENDING_CAPTURE_STATES` omits
 * `processing`, so nothing ever re-enqueued it. Production accumulated 90 such rows.
 */
test('a capture stranded in processing with no live job is recovered', () => {
  withAssistantContext(({ database, clock, graph, ownerId }) => {
    const queue = new CaptureQueueStore(database, clock);
    const evidence = graph.evidence.recordTextEvidence({
      ownerId, deviceId: null, sourceType: 'screenshot', parentEvidenceId: null,
      sourceEventId: 'cap_1', sourceRef: 'app:code', sourceTimezone: null,
      capturedAtUtc: CAPTURED_AT, sensitivity: 'sensitive',
      retentionUntilUtc: null, metadata: {}, text: 'x',
    });
    enqueueCapture(queue, ownerId, evidence.id, 'a'.repeat(64));
    queue.setState(evidence.id, 'processing');

    const recovered = queue.recoverStrandedProcessing(ownerId, graph.jobs.listLiveImageExtractionEvidenceIds(ownerId));

    assert.equal(recovered, 1);
    assert.equal(queue.require(evidence.id).state, 'queued');
  });
});

/** A capture a worker is actively holding must not be reset underneath it. */
test('a capture processing under a live job is left alone', () => {
  withAssistantContext(({ database, clock, graph, ownerId }) => {
    const queue = new CaptureQueueStore(database, clock);
    const evidence = graph.evidence.recordTextEvidence({
      ownerId, deviceId: null, sourceType: 'screenshot', parentEvidenceId: null,
      sourceEventId: 'cap_2', sourceRef: 'app:code', sourceTimezone: null,
      capturedAtUtc: CAPTURED_AT, sensitivity: 'sensitive',
      retentionUntilUtc: null, metadata: {}, text: 'x',
    });
    enqueueCapture(queue, ownerId, evidence.id, 'b'.repeat(64));
    queue.setState(evidence.id, 'processing');
    graph.jobs.enqueue({
      ownerId, jobType: 'image_extraction', payload: { evidenceId: evidence.id },
      idempotencyKey: `image_extraction:${evidence.id}`,
    }, 350);

    const recovered = queue.recoverStrandedProcessing(ownerId, graph.jobs.listLiveImageExtractionEvidenceIds(ownerId));

    assert.equal(recovered, 0);
    assert.equal(queue.require(evidence.id).state, 'processing');
  });
});

/** Recovery must leave the capture enqueueable exactly once. */
test('a recovered capture takes one extraction job, not two', () => {
  withAssistantContext(({ database, clock, graph, ownerId }) => {
    const queue = new CaptureQueueStore(database, clock);
    const evidence = graph.evidence.recordTextEvidence({
      ownerId, deviceId: null, sourceType: 'screenshot', parentEvidenceId: null,
      sourceEventId: 'cap_3', sourceRef: 'app:code', sourceTimezone: null,
      capturedAtUtc: CAPTURED_AT, sensitivity: 'sensitive',
      retentionUntilUtc: null, metadata: {}, text: 'x',
    });
    enqueueCapture(queue, ownerId, evidence.id, 'c'.repeat(64));
    queue.setState(evidence.id, 'processing');
    queue.recoverStrandedProcessing(ownerId, graph.jobs.listLiveImageExtractionEvidenceIds(ownerId));

    const key = `image_extraction:${evidence.id}`;
    graph.jobs.enqueue({
      ownerId, jobType: 'image_extraction', payload: { evidenceId: evidence.id },
      idempotencyKey: key,
    }, 350);
    graph.jobs.enqueue({
      ownerId, jobType: 'image_extraction', payload: { evidenceId: evidence.id },
      idempotencyKey: key,
    }, 350);

    const queued = graph.jobs.listByStatus(ownerId, 'queued')
      .filter((job) => job.job_type === 'image_extraction');
    assert.equal(queued.length, 1);
  });
});

/** A malformed live payload used to make `NOT IN` compare against NULL and silently recover
 * nothing. Parsing with the schema fails loudly instead. */
test('a live job with an unreadable payload fails loudly instead of disabling recovery', () => {
  withAssistantContext(({ graph, ownerId }) => {
    graph.jobs.enqueue({
      ownerId, jobType: 'image_extraction', payload: {}, idempotencyKey: 'image_extraction:broken',
    }, 350);

    assert.throws(() => graph.jobs.listLiveImageExtractionEvidenceIds(ownerId));
  });
});

import assert from 'node:assert/strict';
import test from 'node:test';

import { UNRECORDED_RUN_IDENTITY } from '../src/status-server/dashboard-runs/run-identity.js';
import { parseStatusMetadata } from '../src/status-server/status-file.js';

const ARTIFACT = {
  artifactType: 'summary_request',
  artifactRequestId: 'req-1',
  artifactPayload: { question: 'what' },
};

function parseDeferred(artifact: object) {
  return parseStatusMetadata(JSON.stringify({
    requestId: 'req-1',
    running: false,
    terminalState: 'completed',
    deferredArtifacts: [artifact],
  })).deferredArtifacts;
}

test('deferred artifacts carry their run identity across the status transport', () => {
  const identity = {
    operationType: 'summary',
    operationPresetId: 'summary',
    modelPresetId: 'default',
    operationPresetJson: '{"id":"summary"}',
    modelPresetJson: '{"id":"default"}',
  };
  assert.deepEqual(parseDeferred({ ...ARTIFACT, identity }), [{ ...ARTIFACT, identity }]);
  assert.deepEqual(
    parseDeferred({ ...ARTIFACT, identity: UNRECORDED_RUN_IDENTITY }),
    [{ ...ARTIFACT, identity: UNRECORDED_RUN_IDENTITY }],
  );
});

// A sender that omits or corrupts identity is a bug, not an older client: the artifact is
// rejected rather than silently persisted as "not recorded".
test('deferred artifacts without a valid identity are rejected', () => {
  assert.equal(parseDeferred(ARTIFACT), null);
  assert.equal(parseDeferred({ ...ARTIFACT, identity: {} }), null);
  assert.equal(
    parseDeferred({ ...ARTIFACT, identity: { ...UNRECORDED_RUN_IDENTITY, operationType: 'not-an-operation' } }),
    null,
  );
});

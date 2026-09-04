import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildPlannerDebugArtifact,
  buildFailedRequestArtifact,
  buildSummaryRequestArtifact,
  clearSummaryArtifactState,
  createPlannerDebugRecorder,
} from '../src/summary/artifacts.js';
import { parseRuntimeArtifactUri, readRuntimeArtifact } from '../src/state/runtime-artifacts.js';
import type { RuntimeArtifactRecord } from '../src/state/runtime-artifacts.js';
import { JsonRecordReader } from '../src/lib/json-record-reader.js';
import { getRuntimeDatabase } from '../src/state/runtime-db.js';
import { queryDashboardRunDetailFromDb } from '../src/status-server/dashboard-runs/queries.js';
import { operationOnlyRunIdentity } from '../src/status-server/dashboard-runs/run-identity.js';
import { requestJson } from './helpers/dashboard-http.js';
import { DashboardTestServer } from './helpers/dashboard-server-fixture.js';

const ARTIFACT_POLL_INTERVAL_MS = 20;
const ARTIFACT_TIMEOUT_MS = 5000;

function sleep(delayMs: number): Promise<void> {
  return new Promise<void>((resolve) => { setTimeout(resolve, delayMs); });
}

/** Resolves a `db://` reference the way any consumer would: parse, then read. */
async function resolveArtifactReference(reference: string | null): Promise<RuntimeArtifactRecord> {
  assert.ok(reference, 'a reference must be produced');
  const artifactId = parseRuntimeArtifactUri(reference);
  assert.ok(artifactId, `reference must be parseable by parseRuntimeArtifactUri: ${reference}`);
  const deadline = Date.now() + ARTIFACT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const record = readRuntimeArtifact(artifactId);
    if (record) {
      return record;
    }
    await sleep(ARTIFACT_POLL_INTERVAL_MS);
  }
  throw new Error(`Reference ${reference} never resolved to a stored artifact.`);
}

test('planner debug and failed-request references in a summary artifact resolve to stored payloads', async () => {
  const server = await DashboardTestServer.start('siftkit-status-artifact-ref-');
  const requestId = 'artifact-reference-request';
  try {
    const recorder = createPlannerDebugRecorder({
      requestId,
      question: 'what failed?',
      sourceKind: 'command-output',
      commandExitCode: 1,
      commandText: 'npm test',
    });
    recorder.record({ kind: 'planner_tool', toolName: 'find_text', output: { text: 'hit' } });

    const identity = operationOnlyRunIdentity('summary');
    const plannerDebugArtifact = buildPlannerDebugArtifact({
      requestId,
      finalOutput: 'the build failed',
      classification: 'command_failure',
      rawReviewRequired: true,
      identity,
    });
    assert.ok(plannerDebugArtifact, 'planner debug artifact must be produced');
    const failedArtifact = buildFailedRequestArtifact({
      requestId,
      question: 'what failed?',
      inputText: 'npm test output',
      command: 'npm test',
      error: 'Planner mode failed: planner_failed.',
      identity,
    });
    const summaryArtifact = buildSummaryRequestArtifact({
      requestId,
      question: 'what failed?',
      inputText: 'npm test output',
      command: 'npm test',
      provider: 'real',
      backend: 'exl3',
      model: 'mock-model',
      classification: 'command_failure',
      summary: null,
      error: 'Planner mode failed: planner_failed.',
      identity,
    });

    await requestJson(`${server.baseUrl}/status`, {
      method: 'POST',
      body: JSON.stringify({ running: true, taskKind: 'summary', requestId }),
    });
    await requestJson(`${server.baseUrl}/status/terminal-metadata`, {
      method: 'POST',
      body: JSON.stringify({
        running: false,
        taskKind: 'summary',
        requestId,
        terminalState: 'failed',
        deferredArtifacts: [plannerDebugArtifact, failedArtifact, summaryArtifact],
      }),
    });

    // Start from the persisted summary_request payload, exactly as a dashboard or
    // CLI consumer would, and follow its references outward.
    const summaryRecord = await resolveArtifactReference(
      `db://runtime-artifacts/status:summary_request:${requestId}`,
    );
    const summaryPayload = summaryRecord.contentJson;
    assert.ok(summaryPayload, 'summary_request artifact must store a JSON payload');

    const plannerDebugRecord = await resolveArtifactReference(
      typeof summaryPayload.plannerDebugPath === 'string' ? summaryPayload.plannerDebugPath : null,
    );
    const plannerDebugPayload = plannerDebugRecord.contentJson;
    const plannerFinal = JsonRecordReader.asObject(plannerDebugPayload?.final);
    assert.equal(plannerFinal?.finalOutput, 'the build failed');

    const failedRecord = await resolveArtifactReference(
      typeof summaryPayload.failedRequestPath === 'string' ? summaryPayload.failedRequestPath : null,
    );
    assert.equal(failedRecord.contentJson?.error, 'Planner mode failed: planner_failed.');

    // The failed summary run is still identified as a summary operation in the run log.
    const run = queryDashboardRunDetailFromDb(getRuntimeDatabase(), requestId);
    assert.equal(run?.run.status, 'failed');
    assert.equal(run?.run.operationType, 'summary');
  } finally {
    clearSummaryArtifactState(requestId);
    await server.close();
  }
});

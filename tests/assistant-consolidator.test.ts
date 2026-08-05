import test from 'node:test';
import assert from 'node:assert/strict';

import type { AssistantGraph } from '../src/assistant/assistant-graph.js';
import { CandidateConsolidator } from '../src/assistant/ingestion/consolidator.js';
import { StructuredOutputRunner } from '../src/assistant/inference/structured-runner.js';
import { FakeAssistantInference } from './helpers/assistant-inference-fake.js';
import { withAssistantContextAsync } from './helpers/assistant-fixture.js';

function seedCandidate(
  graph: AssistantGraph,
  ownerId: string,
  displayName: string,
  sourceEventId: string,
): string {
  const evidence = graph.evidence.recordTextEvidence({
    ownerId, deviceId: null, sourceType: 'conversation_message', parentEvidenceId: null,
    sourceEventId, sourceRef: 'chat_1', sourceTimezone: null,
    capturedAtUtc: '2026-08-05T09:00:00.000Z', sensitivity: 'personal',
    retentionUntilUtc: null, metadata: {}, text: `I use ${displayName}.`,
  });
  const observation = graph.observations.record({
    ownerId, evidenceId: evidence.id, observationType: 'conversation_statement',
    payload: {}, confidence: 0.9, sensitivity: 'personal',
    extractorName: 'conversation_memory_extractor', extractorVersion: '1',
  });
  const candidate = graph.candidates.propose({
    ownerId, observationId: observation.id,
    subject: { nodeType: 'person', displayName: 'the user' },
    predicate: 'USES',
    object: { kind: 'unresolved', nodeType: 'software', displayName },
    scope: null, basis: 'explicit_user_statement', confidence: 0.9, sensitivity: 'personal',
    validFromUtc: null, validToUtc: null, rationale: `User said "I use ${displayName}".`,
  });
  return candidate?.id ?? '';
}

function consolidator(graph: AssistantGraph, ...responses: string[]): CandidateConsolidator {
  return new CandidateConsolidator(
    graph,
    new StructuredOutputRunner(new FakeAssistantInference(responses)),
  );
}

test('a suggested duplicate rejects the later candidate and keeps the earlier one', async () => {
  await withAssistantContextAsync(async ({ graph, ownerId }) => {
    const ids = ['PowerShell', 'Powershell'].map(
      (name, index) => seedCandidate(graph, ownerId, name, `chat_1:m${index}`),
    );
    const result = await consolidator(graph, JSON.stringify({
      duplicateGroups: [{ keepCandidateId: ids[0], dropCandidateIds: [ids[1]] }],
      entityMatches: [],
    })).consolidate({ ownerId, candidateIds: ids, abortSignal: null });

    assert.deepEqual(result.droppedCandidateIds, [ids[1]]);
    assert.equal(graph.candidates.requireCandidate(ids[0] ?? '').status, 'pending');
    assert.equal(graph.candidates.requireCandidate(ids[1] ?? '').status, 'rejected');
  });
});

test('a suggestion naming an unknown candidate is ignored', async () => {
  await withAssistantContextAsync(async ({ graph, ownerId }) => {
    const candidateId = seedCandidate(graph, ownerId, 'PowerShell', 'chat_1:m0');
    const result = await consolidator(graph, JSON.stringify({
      duplicateGroups: [{ keepCandidateId: 'cand_nope', dropCandidateIds: ['cand_also_nope'] }],
      entityMatches: [{ candidateId: 'cand_nope', nodeId: 'node_nope', score: 0.99 }],
    })).consolidate({ ownerId, candidateIds: [candidateId], abortSignal: null });

    assert.deepEqual(result.droppedCandidateIds, []);
    assert.deepEqual(result.entityMatches, []);
    assert.equal(graph.candidates.requireCandidate(candidateId).status, 'pending');
  });
});

test('a suggestion below the score threshold or naming a missing node yields no match', async () => {
  await withAssistantContextAsync(async ({ graph, ownerId }) => {
    const candidateId = seedCandidate(graph, ownerId, 'PowerShell', 'chat_1:m0');
    const node = graph.nodes.createNode({
      ownerId, type: 'software', canonicalKey: null, displayName: 'PowerShell',
      description: null, sensitivity: 'low', properties: {},
    });
    const result = await consolidator(graph, JSON.stringify({
      duplicateGroups: [],
      entityMatches: [
        { candidateId, nodeId: node.id, score: 0.5 },
        { candidateId, nodeId: 'node_missing', score: 0.99 },
        { candidateId, nodeId: node.id, score: 0.99 },
      ],
    })).consolidate({ ownerId, candidateIds: [candidateId], abortSignal: null });

    assert.deepEqual(result.entityMatches, [{ candidateId, nodeId: node.id, score: 0.99 }]);
  });
});

test('a candidate already rejected is not dropped twice', async () => {
  await withAssistantContextAsync(async ({ graph, ownerId }) => {
    const keepId = seedCandidate(graph, ownerId, 'PowerShell', 'chat_1:m0');
    const dropId = seedCandidate(graph, ownerId, 'Powershell', 'chat_1:m1');
    graph.candidates.reject(dropId, 'rejected_by_user');

    const result = await consolidator(graph, JSON.stringify({
      duplicateGroups: [{ keepCandidateId: keepId, dropCandidateIds: [dropId, keepId] }],
      entityMatches: [],
    })).consolidate({ ownerId, candidateIds: [keepId, dropId], abortSignal: null });

    assert.deepEqual(result.droppedCandidateIds, []);
    assert.equal(graph.candidates.requireCandidate(keepId).status, 'pending');
  });
});

test('unusable structured output leaves every candidate pending and is audited', async () => {
  await withAssistantContextAsync(async ({ graph, ownerId }) => {
    const candidateId = seedCandidate(graph, ownerId, 'PowerShell', 'chat_1:m0');
    const result = await consolidator(graph, 'not json at all', 'still not json')
      .consolidate({ ownerId, candidateIds: [candidateId], abortSignal: null });

    assert.deepEqual(result.droppedCandidateIds, []);
    assert.deepEqual(result.entityMatches, []);
    assert.equal(graph.candidates.requireCandidate(candidateId).status, 'pending');
    assert.equal(
      graph.audit.listAuditEvents(ownerId, 100).filter(
        (row) => row.event_type === 'consolidation_rejected',
      ).length,
      1,
    );
  });
});

test('the consolidator never merges nodes and never writes an assertion', async () => {
  await withAssistantContextAsync(async ({ graph, ownerId }) => {
    const before = graph.graphVersion;
    const result = await consolidator(graph, JSON.stringify({
      duplicateGroups: [], entityMatches: [],
    })).consolidate({ ownerId, candidateIds: [], abortSignal: null });

    assert.deepEqual(result.droppedCandidateIds, []);
    assert.equal(graph.graphVersion, before);
    assert.equal(graph.nodes.listMerges(ownerId).length, 0);
  });
});

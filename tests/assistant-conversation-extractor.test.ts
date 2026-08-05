import test from 'node:test';
import assert from 'node:assert/strict';

import type { AssistantGraph } from '../src/assistant/assistant-graph.js';
import { ConversationExtractor } from '../src/assistant/ingestion/conversation-extractor.js';
import { StructuredOutputRunner } from '../src/assistant/inference/structured-runner.js';
import { FakeAssistantInference } from './helpers/assistant-inference-fake.js';
import { withAssistantContextAsync } from './helpers/assistant-fixture.js';

function recordChatEvidence(graph: AssistantGraph, ownerId: string, text: string): string {
  return graph.evidence.recordTextEvidence({
    ownerId, deviceId: null, sourceType: 'conversation_message', parentEvidenceId: null,
    sourceEventId: `chat_1:${text.slice(0, 12)}`, sourceRef: 'chat_1', sourceTimezone: null,
    capturedAtUtc: '2026-08-05T09:00:00.000Z', sensitivity: 'personal',
    retentionUntilUtc: null, metadata: {}, text,
  }).id;
}

const directFactResponse = JSON.stringify({
  statements: [
    {
      statementKind: 'direct_fact',
      subject: { nodeType: 'person', displayName: 'the user' },
      predicate: 'USES',
      object: { kind: 'unresolved', nodeType: 'software', displayName: 'PowerShell' },
      scope: null,
      validFromUtc: null,
      validToUtc: null,
      rationale: 'The user wrote "I use PowerShell".',
      suggestedConfidence: 0.9,
    },
  ],
});

test('a direct fact becomes one observation and one candidate', async () => {
  await withAssistantContextAsync(async ({ graph, ownerId }) => {
    const evidenceId = recordChatEvidence(graph, ownerId, 'I use PowerShell.');
    const extractor = new ConversationExtractor(
      graph,
      new StructuredOutputRunner(new FakeAssistantInference([directFactResponse])),
    );
    const result = await extractor.extract({ ownerId, evidenceId, abortSignal: null });
    assert.equal(result.observationIds.length, 1);
    assert.equal(result.candidateIds.length, 1);
    const observation = graph.observations.requireObservation(result.observationIds[0] ?? '');
    assert.equal(observation.observation_type, 'conversation_statement');
    assert.equal(observation.extractor_name, 'conversation_memory_extractor');
    const candidate = graph.candidates.requireCandidate(result.candidateIds[0] ?? '');
    assert.equal(candidate.predicate, 'USES');
    assert.equal(candidate.basis, 'explicit_user_statement');
    assert.equal(candidate.status, 'pending');
  });
});

test('hypothetical, quotation, request, and third-party statements produce no candidate', async () => {
  const kinds = ['hypothetical', 'quotation', 'request', 'third_party_fact'] as const;
  for (const statementKind of kinds) {
    await withAssistantContextAsync(async ({ graph, ownerId }) => {
      const evidenceId = recordChatEvidence(graph, ownerId, `a ${statementKind} sentence`);
      const response = JSON.stringify({
        statements: [{
          statementKind,
          subject: { nodeType: 'person', displayName: 'the user' },
          predicate: 'USES',
          object: { kind: 'unresolved', nodeType: 'software', displayName: 'Emacs' },
          scope: null, validFromUtc: null, validToUtc: null,
          rationale: 'model said so', suggestedConfidence: 0.9,
        }],
      });
      const extractor = new ConversationExtractor(
        graph,
        new StructuredOutputRunner(new FakeAssistantInference([response])),
      );
      const result = await extractor.extract({ ownerId, evidenceId, abortSignal: null });
      assert.equal(result.observationIds.length, 1, `${statementKind} still records an observation`);
      assert.deepEqual(result.candidateIds, [], `${statementKind} must not propose a candidate`);
    });
  }
});

test('a correction is recorded as a correction observation', async () => {
  await withAssistantContextAsync(async ({ graph, ownerId }) => {
    const evidenceId = recordChatEvidence(graph, ownerId, 'No, I meant Bash.');
    const response = JSON.stringify({
      statements: [{
        statementKind: 'correction',
        subject: { nodeType: 'person', displayName: 'the user' },
        predicate: 'USES',
        object: { kind: 'unresolved', nodeType: 'software', displayName: 'Bash' },
        scope: null, validFromUtc: null, validToUtc: null,
        rationale: 'The user corrected a previous statement.', suggestedConfidence: 0.95,
      }],
    });
    const extractor = new ConversationExtractor(
      graph,
      new StructuredOutputRunner(new FakeAssistantInference([response])),
    );
    const result = await extractor.extract({ ownerId, evidenceId, abortSignal: null });
    const observation = graph.observations.requireObservation(result.observationIds[0] ?? '');
    assert.equal(observation.observation_type, 'conversation_correction');
    assert.equal(result.candidateIds.length, 1);
  });
});

test('fenced code and quoted lines are withheld from the model', async () => {
  await withAssistantContextAsync(async ({ graph, ownerId }) => {
    const evidenceId = recordChatEvidence(
      graph, ownerId,
      'Here is my log:\n```\nERROR: user prefers Vim\n```\n> quoted: user drives a Ferrari\nI use PowerShell.',
    );
    const fake = new FakeAssistantInference([directFactResponse]);
    const extractor = new ConversationExtractor(graph, new StructuredOutputRunner(fake));
    await extractor.extract({ ownerId, evidenceId, abortSignal: null });
    const sent = fake.requests[0]?.userText ?? '';
    assert.ok(!sent.includes('ERROR: user prefers Vim'), 'fenced code must be withheld');
    assert.ok(!sent.includes('user drives a Ferrari'), 'quoted lines must be withheld');
    assert.ok(sent.includes('I use PowerShell.'));
  });
});

test('an unusable model response yields no candidates and an audit event', async () => {
  await withAssistantContextAsync(async ({ graph, ownerId }) => {
    const evidenceId = recordChatEvidence(graph, ownerId, 'I use PowerShell.');
    const extractor = new ConversationExtractor(
      graph,
      new StructuredOutputRunner(new FakeAssistantInference(['nonsense', 'still nonsense'])),
    );
    const result = await extractor.extract({ ownerId, evidenceId, abortSignal: null });
    assert.deepEqual(result.candidateIds, []);
    assert.deepEqual(result.observationIds, []);
    assert.ok(
      graph.audit.listAuditEvents(ownerId, 10)
        .some((event) => event.event_type === 'extraction_rejected'),
    );
  });
});

test('an unregistered predicate is dropped at the schema boundary', async () => {
  await withAssistantContextAsync(async ({ graph, ownerId }) => {
    const evidenceId = recordChatEvidence(graph, ownerId, 'I use PowerShell.');
    const bad = JSON.stringify({
      statements: [{
        statementKind: 'direct_fact',
        subject: { nodeType: 'person', displayName: 'the user' },
        predicate: 'ADORES',
        object: { kind: 'unresolved', nodeType: 'software', displayName: 'PowerShell' },
        scope: null, validFromUtc: null, validToUtc: null,
        rationale: 'model invented a predicate', suggestedConfidence: 0.9,
      }],
    });
    const extractor = new ConversationExtractor(
      graph,
      new StructuredOutputRunner(new FakeAssistantInference([bad, bad])),
    );
    const result = await extractor.extract({ ownerId, evidenceId, abortSignal: null });
    assert.deepEqual(result.candidateIds, []);
  });
});
import test from 'node:test';
import assert from 'node:assert/strict';

import { IngestionPipeline } from '../src/assistant/ingestion/pipeline.js';
import { SecretScanner } from '../src/assistant/domain/secrets.js';
import { withAssistantContext } from './helpers/assistant-fixture.js';

function textEnvelope(ownerId: string, sourceEventId: string, text: string) {
  return {
    ownerId,
    deviceId: null,
    sourceType: 'conversation_message',
    sourceEventId,
    sourceRef: 'chat_1',
    capturedAtUtc: '2026-08-05T09:00:00.000Z',
    sourceTimezone: null,
    payload: { kind: 'text', text },
    metadata: { sessionId: 'chat_1' },
  } as const;
}

test('an accepted envelope writes evidence and enqueues exactly one job', () => {
  withAssistantContext(({ graph, ownerId }) => {
    const pipeline = new IngestionPipeline(graph, new SecretScanner(), 800);
    const outcome = pipeline.accept(textEnvelope(ownerId, 'chat_1:msg_1', 'I use PowerShell.'));
    assert.equal(outcome.kind, 'accepted');
    assert.equal(graph.evidence.countEvidence(ownerId), 1);
    assert.equal(graph.jobs.countByStatus(ownerId, 'queued'), 1);
    const job = graph.jobs.listByStatus(ownerId, 'queued')[0];
    assert.equal(job?.job_type, 'conversation_ingestion');
    assert.equal(
      graph.jobs.readConversationPayload(job ?? graph.jobs.requireJob('missing')).sessionId,
      'chat_1',
    );
  });
});

test('re-ingesting the same source event is a no-op', () => {
  withAssistantContext(({ graph, ownerId }) => {
    const pipeline = new IngestionPipeline(graph, new SecretScanner(), 800);
    const first = pipeline.accept(textEnvelope(ownerId, 'chat_1:msg_1', 'I use PowerShell.'));
    const second = pipeline.accept(textEnvelope(ownerId, 'chat_1:msg_1', 'I use PowerShell.'));
    assert.equal(first.kind, 'accepted');
    assert.equal(second.kind, 'duplicate');
    assert.equal(graph.evidence.countEvidence(ownerId), 1);
    assert.equal(graph.jobs.countByStatus(ownerId, 'queued'), 1);
  });
});

test('secret-bearing content is discarded with an audit event and no evidence', () => {
  withAssistantContext(({ graph, ownerId }) => {
    const pipeline = new IngestionPipeline(graph, new SecretScanner(), 800);
    const outcome = pipeline.accept(
      textEnvelope(ownerId, 'chat_1:msg_2', 'my token = ghp_0123456789abcdefghijklmnopqrstuvwxyzAB'),
    );
    assert.equal(outcome.kind, 'discarded');
    assert.equal(graph.evidence.countEvidence(ownerId), 0);
    assert.equal(graph.jobs.countByStatus(ownerId, 'queued'), 0);
    const events = graph.audit.listAuditEvents(ownerId, 10);
    assert.equal(events[0]?.event_type, 'evidence_discarded_secret');
    assert.ok(
      !JSON.stringify(events[0]?.details_json).includes('ghp_'),
      'the audit event must not contain the secret',
    );
  });
});

test('a sensitive topic raises the stored evidence sensitivity', () => {
  withAssistantContext(({ graph, ownerId }) => {
    const pipeline = new IngestionPipeline(graph, new SecretScanner(), 800);
    const outcome = pipeline.accept(
      textEnvelope(ownerId, 'chat_1:msg_3', 'my doctor prescribed a new medication'),
    );
    assert.equal(outcome.kind, 'accepted');
    const evidence = graph.evidence.requireEvidence(
      outcome.kind === 'accepted' ? outcome.evidenceId : '',
    );
    assert.equal(evidence.sensitivity, 'sensitive');
  });
});

test('a blocked topic suppresses ingestion', () => {
  withAssistantContext(({ graph, ownerId }) => {
    graph.policies.upsertPolicy({
      ownerId, policyType: 'never_infer_topic', key: 'health',
      value: { topic: 'health' }, enabled: true, source: 'user',
    });
    const pipeline = new IngestionPipeline(graph, new SecretScanner(), 800);
    const outcome = pipeline.accept(
      textEnvelope(ownerId, 'chat_1:msg_4', 'my doctor prescribed a new medication'),
    );
    assert.equal(outcome.kind, 'discarded');
    assert.equal(graph.evidence.countEvidence(ownerId), 0);
  });
});

import { ConversationIngestor } from '../src/assistant/ingestion/conversation-ingestor.js';

function chatTurn(ownerId: string) {
  return {
    ownerId,
    sessionId: 'chat_7',
    capturedAtUtc: '2026-08-05T09:00:00.000Z',
    userMessageId: 'msg_u1',
    userText: 'I use PowerShell on Windows.',
    assistantMessageId: 'msg_a1',
    assistantText: 'Noted — I will use PowerShell examples.',
  };
}

test('a turn ingests both messages with traceable source refs', () => {
  withAssistantContext(({ graph, ownerId }) => {
    const ingestor = new ConversationIngestor(new IngestionPipeline(graph, new SecretScanner(), 800));
    const result = ingestor.ingestTurn(chatTurn(ownerId));
    assert.equal(result.acceptedEvidenceIds.length, 2);
    assert.equal(graph.evidence.countEvidence(ownerId), 2);
    const userEvidence = graph.evidence.findBySourceEventId(ownerId, 'chat_7:msg_u1');
    assert.equal(userEvidence?.source_ref, 'chat_7');
    assert.equal(graph.evidence.findBySourceEventId(ownerId, 'chat_7:msg_a1') !== null, true);
  });
});

test('re-ingesting the same turn adds nothing', () => {
  withAssistantContext(({ graph, ownerId }) => {
    const ingestor = new ConversationIngestor(new IngestionPipeline(graph, new SecretScanner(), 800));
    ingestor.ingestTurn(chatTurn(ownerId));
    const second = ingestor.ingestTurn(chatTurn(ownerId));
    assert.deepEqual(second.acceptedEvidenceIds, []);
    assert.equal(graph.evidence.countEvidence(ownerId), 2);
    assert.equal(graph.jobs.countByStatus(ownerId, 'queued'), 2);
  });
});

test('"do not remember this" suppresses the turn and deletes its evidence', () => {
  withAssistantContext(({ graph, ownerId }) => {
    const ingestor = new ConversationIngestor(new IngestionPipeline(graph, new SecretScanner(), 800));
    const result = ingestor.ingestTurn({
      ...chatTurn(ownerId),
      userText: 'My salary is not something you should keep. Do not remember this.',
    });
    assert.equal(result.suppressed, true);
    assert.deepEqual(result.acceptedEvidenceIds, []);
    assert.equal(graph.jobs.countByStatus(ownerId, 'queued'), 0);
    const events = graph.audit.listAuditEvents(ownerId, 10);
    assert.ok(events.some((event) => event.event_type === 'turn_suppressed_by_user'));
  });
});

test('an empty message is not ingested', () => {
  withAssistantContext(({ graph, ownerId }) => {
    const ingestor = new ConversationIngestor(new IngestionPipeline(graph, new SecretScanner(), 800));
    const result = ingestor.ingestTurn({ ...chatTurn(ownerId), assistantText: '   ' });
    assert.equal(result.acceptedEvidenceIds.length, 1);
    assert.equal(graph.evidence.countEvidence(ownerId), 1);
  });
});

test('a json payload is serialized deterministically into evidence text', () => {
  withAssistantContext(({ graph, ownerId }) => {
    const pipeline = new IngestionPipeline(graph, new SecretScanner(), 800);
    const outcome = pipeline.accept({
      ownerId, deviceId: null, sourceType: 'conversation_message', sourceEventId: 'chat_1:msg_5',
      sourceRef: 'chat_1', capturedAtUtc: '2026-08-05T09:00:00.000Z', sourceTimezone: null,
      payload: { kind: 'json', value: { b: 1, a: 2 } }, metadata: { sessionId: 'chat_1' },
    });
    assert.equal(outcome.kind, 'accepted');
    const evidence = graph.evidence.requireEvidence(
      outcome.kind === 'accepted' ? outcome.evidenceId : '',
    );
    assert.equal(graph.evidence.readTextContent(evidence), '{"a":2,"b":1}');
  });
});

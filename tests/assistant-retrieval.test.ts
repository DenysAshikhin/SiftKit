import test from 'node:test';
import assert from 'node:assert/strict';

import { QueryIntentExtractor } from '../src/assistant/retrieval/query-intent.js';
import { MemoryRetriever } from '../src/assistant/retrieval/memory-retriever.js';
import {
  EstimateTokenCounter, type TokenCount, type TokenCounter,
} from '../src/assistant/domain/tokens.js';
import { OWNER_PERSON_CANONICAL_KEY } from '../src/assistant/storage/schema.js';
import { withAssistantContextAsync } from './helpers/assistant-fixture.js';

test('intent extraction finds entities, temporal intent, and task type', () => {
  const extractor = new QueryIntentExtractor();
  const current = extractor.extract('What shell do I use on Windows?');
  assert.equal(current.temporal.kind, 'current');
  assert.ok(current.terms.includes('shell'));
  assert.ok(current.terms.includes('windows'));
  assert.ok(!current.terms.includes('do'), 'stop words are dropped');

  const historical = extractor.extract('What did I use last year?');
  assert.equal(historical.temporal.kind, 'historical');

  assert.equal(extractor.extract('help me debug this stack trace').taskType, 'troubleshooting');
  assert.equal(extractor.extract('write a function that sorts').taskType, 'coding');
  assert.equal(extractor.extract('what do you remember about me').taskType, 'recall');
});

test('an empty match returns without invoking token counting', async () => {
  class RejectingTokenCounter implements TokenCounter {
    async count(): Promise<TokenCount> {
      throw new Error('token counting must not run for an empty match');
    }
  }

  await withAssistantContextAsync(async ({ graph, ownerId }) => {
    const retriever = new MemoryRetriever(graph, new RejectingTokenCounter(), 400);
    const result = await retriever.retrieve({ ownerId, userMessage: 'unmatched topic' });
    assert.equal(result.renderedBlock, '');
    assert.equal(result.tokenCount, 0);
  });
});

test('retrieval returns cited lines for a matching query and nothing for a miss', async () => {
  await withAssistantContextAsync(async ({ graph, ownerId }) => {
    const owner = graph.nodes.createNode({
      ownerId, type: 'person', canonicalKey: OWNER_PERSON_CANONICAL_KEY, displayName: 'the user',
      description: null, sensitivity: 'personal', properties: {},
    });
    const shell = graph.nodes.createNode({
      ownerId, type: 'software', canonicalKey: null, displayName: 'PowerShell',
      description: null, sensitivity: 'low', properties: {},
    });
    const evidence = graph.evidence.recordTextEvidence({
      ownerId, deviceId: null, sourceType: 'conversation_message', parentEvidenceId: null,
      sourceEventId: 'chat_1:m1', sourceRef: 'chat_1', sourceTimezone: null,
      capturedAtUtc: '2026-08-05T09:00:00.000Z', sensitivity: 'personal',
      retentionUntilUtc: null, metadata: {}, text: 'seed',
    });
    graph.assertionService.assert({
      ownerId, actorType: 'user', actorRef: null, subjectNodeId: owner.id, predicate: 'PREFERS',
      object: { kind: 'node', nodeId: shell.id }, scopeNodeId: null,
      basis: 'explicit_user_statement', sensitivity: 'personal',
      validFromUtc: null, validToUtc: null, observedAtUtc: '2026-08-05T09:00:00.000Z',
      topics: [], attributes: {},
      searchText: { subject: 'the user', predicate: 'PREFERS', object: 'PowerShell', scope: '' },
      evidence: [{ evidenceId: evidence.id, stance: 'supports', weight: 0.9 }],
    });

    const retriever = new MemoryRetriever(graph, new EstimateTokenCounter(4), 400);
    const hit = await retriever.retrieve({ ownerId, userMessage: 'which shell for PowerShell work?' });
    assert.ok(hit.renderedBlock.includes('## Relevant personal context'));
    assert.ok(hit.renderedBlock.includes('Prefers PowerShell'));
    assert.ok(hit.renderedBlock.includes('[M:'));
    assert.equal(hit.assertionIds.length, 1);

    const miss = await retriever.retrieve({ ownerId, userMessage: 'unrelated kayaking question' });
    assert.equal(miss.renderedBlock, '');
    assert.deepEqual(miss.assertionIds, []);
  });
});

test('a sensitive assertion is never retrieved into a prompt', async () => {
  await withAssistantContextAsync(async ({ graph, ownerId }) => {
    const owner = graph.nodes.createNode({
      ownerId, type: 'person', canonicalKey: OWNER_PERSON_CANONICAL_KEY, displayName: 'the user',
      description: null, sensitivity: 'personal', properties: {},
    });
    const topic = graph.nodes.createNode({
      ownerId, type: 'health_topic', canonicalKey: null, displayName: 'kayaking injury',
      description: null, sensitivity: 'sensitive', properties: {},
    });
    const evidence = graph.evidence.recordTextEvidence({
      ownerId, deviceId: null, sourceType: 'conversation_message', parentEvidenceId: null,
      sourceEventId: 'chat_1:m2', sourceRef: 'chat_1', sourceTimezone: null,
      capturedAtUtc: '2026-08-05T09:00:00.000Z', sensitivity: 'sensitive',
      retentionUntilUtc: null, metadata: {}, text: 'seed',
    });
    graph.assertionService.assert({
      ownerId, actorType: 'user', actorRef: null, subjectNodeId: owner.id,
      predicate: 'INTERESTED_IN', object: { kind: 'node', nodeId: topic.id }, scopeNodeId: null,
      basis: 'explicit_user_statement', sensitivity: 'sensitive',
      validFromUtc: null, validToUtc: null, observedAtUtc: '2026-08-05T09:00:00.000Z',
      topics: [], attributes: {},
      searchText: {
        subject: 'the user', predicate: 'INTERESTED_IN', object: 'kayaking injury', scope: '',
      },
      evidence: [{ evidenceId: evidence.id, stance: 'supports', weight: 0.9 }],
    });
    const retriever = new MemoryRetriever(graph, new EstimateTokenCounter(4), 400);
    const result = await retriever.retrieve({ ownerId, userMessage: 'tell me about kayaking' });
    assert.ok(!result.renderedBlock.includes('kayaking injury'));
  });
});

test('the rendered block never exceeds the token budget', async () => {
  await withAssistantContextAsync(async ({ graph, ownerId }) => {
    const owner = graph.nodes.createNode({
      ownerId, type: 'person', canonicalKey: OWNER_PERSON_CANONICAL_KEY, displayName: 'the user',
      description: null, sensitivity: 'personal', properties: {},
    });
    const evidence = graph.evidence.recordTextEvidence({
      ownerId, deviceId: null, sourceType: 'conversation_message', parentEvidenceId: null,
      sourceEventId: 'chat_1:m3', sourceRef: 'chat_1', sourceTimezone: null,
      capturedAtUtc: '2026-08-05T09:00:00.000Z', sensitivity: 'personal',
      retentionUntilUtc: null, metadata: {}, text: 'seed',
    });
    for (let index = 0; index < 200; index += 1) {
      const tool = graph.nodes.createNode({
        ownerId, type: 'software', canonicalKey: null, displayName: `PowerShell module ${index}`,
        description: null, sensitivity: 'low', properties: {},
      });
      graph.assertionService.assert({
        ownerId, actorType: 'user', actorRef: null, subjectNodeId: owner.id, predicate: 'USES',
        object: { kind: 'node', nodeId: tool.id }, scopeNodeId: null,
        basis: 'explicit_user_statement', sensitivity: 'personal',
        validFromUtc: null, validToUtc: null, observedAtUtc: '2026-08-05T09:00:00.000Z',
        topics: [], attributes: {},
        searchText: {
          subject: 'the user', predicate: 'USES', object: `PowerShell module ${index}`, scope: '',
        },
        evidence: [{ evidenceId: evidence.id, stance: 'supports', weight: 0.9 }],
      });
    }
    const retriever = new MemoryRetriever(graph, new EstimateTokenCounter(4), 200);
    const result = await retriever.retrieve({ ownerId, userMessage: 'PowerShell modules' });
    assert.ok(result.tokenCount <= 200);
    assert.ok(result.assertionIds.length > 0);
    assert.ok(result.assertionIds.length < 200, 'the budget must actually bite');
  });
});

test('retrieval records usage on the projections it drew from', async () => {
  await withAssistantContextAsync(async ({ graph, ownerId }) => {
    graph.projections.upsert({
      ownerId, tier: 2, topicKey: 'powershell', title: 'PowerShell',
      content: '# PowerShell\n- Uses PowerShell daily. [M:ast_1]', contentHash: 'h1',
      tokenCount: 12, tokenizerId: 'estimate', graphVersion: graph.graphVersion,
      includedAssertionIds: ['ast_1'], sensitivity: 'personal',
    });
    const retriever = new MemoryRetriever(graph, new EstimateTokenCounter(4), 400);
    const result = await retriever.retrieve({ ownerId, userMessage: 'PowerShell' });
    assert.equal(result.projectionIds.length > 0, true);
    assert.equal(
      graph.projections.findByTopic(ownerId, 2, 'powershell')?.retrieval_count,
      1,
    );
  });
});

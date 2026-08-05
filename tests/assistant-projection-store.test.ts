import test from 'node:test';
import assert from 'node:assert/strict';

import { withAssistantContext } from './helpers/assistant-fixture.js';

test('upsert creates then replaces a projection in place', () => {
  withAssistantContext(({ graph, ownerId }) => {
    const first = graph.projections.upsert({
      ownerId, tier: 2, topicKey: 'siftkit', title: 'SiftKit',
      content: '# SiftKit\nfirst', contentHash: 'hash-first', tokenCount: 4, tokenizerId: 'estimate',
      graphVersion: 3, includedAssertionIds: ['ast_1'], sensitivity: 'personal',
    });
    assert.equal(first.tier, 2);
    assert.equal(first.relative_path, 'tier2/siftkit.md');
    assert.equal(first.retrieval_count, 0);

    const second = graph.projections.upsert({
      ownerId, tier: 2, topicKey: 'siftkit', title: 'SiftKit',
      content: '# SiftKit\nsecond', contentHash: 'hash-second', tokenCount: 5, tokenizerId: 'estimate',
      graphVersion: 4, includedAssertionIds: ['ast_1', 'ast_2'], sensitivity: 'personal',
    });
    assert.equal(second.id, first.id, 'upsert must not create a second row');
    assert.equal(second.content, '# SiftKit\nsecond');
    assert.equal(second.graph_version, 4);
    assert.notEqual(second.content_hash, first.content_hash);
    assert.equal(graph.projections.listByTier(ownerId, 2).length, 1);
  });
});

test('included assertion ids round-trip as a parsed array', () => {
  withAssistantContext(({ graph, ownerId }) => {
    const row = graph.projections.upsert({
      ownerId, tier: 1, topicKey: 'profile', title: 'Profile', content: '# Profile',
      contentHash: 'hash-p', tokenCount: 2, tokenizerId: 'estimate', graphVersion: 1,
      includedAssertionIds: ['ast_1', 'ast_2'], sensitivity: 'personal',
    });
    assert.deepEqual(graph.projections.readIncludedAssertionIds(row), ['ast_1', 'ast_2']);
  });
});

test('search finds plaintext projections and never sensitive ones', () => {
  withAssistantContext(({ graph, ownerId }) => {
    graph.projections.upsert({
      ownerId, tier: 2, topicKey: 'workstation', title: 'Workstation',
      content: 'Runs an RTX 4090 for local inference.', contentHash: 'hash-w', tokenCount: 8,
      tokenizerId: 'estimate', graphVersion: 1, includedAssertionIds: [], sensitivity: 'personal',
    });
    graph.projections.upsert({
      ownerId, tier: 2, topicKey: 'health', title: 'Health',
      content: 'Runs an RTX 4090 for local inference.', contentHash: 'hash-h', tokenCount: 8,
      tokenizerId: 'estimate', graphVersion: 1, includedAssertionIds: [], sensitivity: 'sensitive',
    });
    const hits = graph.projections.search(ownerId, 'RTX', 10);
    assert.equal(hits.length, 1);
    assert.equal(graph.projections.requireProjection(hits[0] ?? '').topic_key, 'workstation');
  });
});

test('upsert removes the FTS row when a projection turns sensitive', () => {
  withAssistantContext(({ graph, ownerId }) => {
    graph.projections.upsert({
      ownerId, tier: 3, topicKey: 'notes', title: 'Notes', content: 'kayak trip',
      contentHash: 'hash-n1', tokenCount: 3, tokenizerId: 'estimate', graphVersion: 1,
      includedAssertionIds: [], sensitivity: 'low',
    });
    assert.equal(graph.projections.search(ownerId, 'kayak', 10).length, 1);
    graph.projections.upsert({
      ownerId, tier: 3, topicKey: 'notes', title: 'Notes', content: 'kayak trip',
      contentHash: 'hash-n2', tokenCount: 3, tokenizerId: 'estimate', graphVersion: 2,
      includedAssertionIds: [], sensitivity: 'highly_sensitive',
    });
    assert.equal(graph.projections.search(ownerId, 'kayak', 10).length, 0);
  });
});

test('recordRetrieval increments the count and stamps the time', () => {
  withAssistantContext(({ graph, ownerId, clock }) => {
    const row = graph.projections.upsert({
      ownerId, tier: 1, topicKey: 'profile', title: 'Profile', content: '# Profile',
      contentHash: 'hash-p2', tokenCount: 2, tokenizerId: 'estimate', graphVersion: 1,
      includedAssertionIds: [], sensitivity: 'personal',
    });
    clock.advanceSeconds(60);
    const updated = graph.projections.recordRetrieval(row.id);
    assert.equal(updated.retrieval_count, 1);
    assert.equal(updated.last_retrieved_at_utc, clock.nowUtc());
  });
});

test('listStale returns only projections older than the current graph version', () => {
  withAssistantContext(({ graph, ownerId }) => {
    graph.projections.upsert({
      ownerId, tier: 2, topicKey: 'fresh', title: 'Fresh', content: 'a', contentHash: 'hf', tokenCount: 1,
      tokenizerId: 'estimate', graphVersion: 9, includedAssertionIds: [], sensitivity: 'personal',
    });
    graph.projections.upsert({
      ownerId, tier: 2, topicKey: 'stale', title: 'Stale', content: 'b', contentHash: 'hs', tokenCount: 1,
      tokenizerId: 'estimate', graphVersion: 4, includedAssertionIds: [], sensitivity: 'personal',
    });
    const stale = graph.projections.listStale(ownerId, 9).map((row) => row.topic_key);
    assert.deepEqual(stale, ['stale']);
  });
});
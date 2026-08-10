import test from 'node:test';
import assert from 'node:assert/strict';

import { withAssistantContext } from './helpers/assistant-fixture.js';

test('RetrievalUsageStore records parsed IDs and bounded usefulness feedback', () => {
  withAssistantContext(({ graph, ownerId, clock }) => {
    const usage = graph.retrievalUsage.record({
      ownerId, conversationId: 'chat_1', queryHash: 'hash_1',
      assertionIds: ['ast_1'], projectionIds: ['memproj_1'], renderedTokenCount: 42,
    });
    assert.deepEqual(graph.retrievalUsage.readAssertionIds(usage), ['ast_1']);
    assert.deepEqual(graph.retrievalUsage.readProjectionIds(usage), ['memproj_1']);
    assert.equal(graph.retrievalUsage.listRecent(ownerId, 10)[0]?.id, usage.id);

    clock.advanceSeconds(1);
    assert.equal(graph.retrievalUsage.setUsefulness(usage.id, 0.75).usefulness_feedback, 0.75);
    assert.throws(() => graph.retrievalUsage.setUsefulness(usage.id, 1.1), /between -1 and 1/);
  });
});

test('RetrievalUsageStore isolates owners and rejects malformed persisted ID arrays', () => {
  withAssistantContext(({ graph, ownerId, database }) => {
    const usage = graph.retrievalUsage.record({
      ownerId, conversationId: null, queryHash: 'hash_2',
      assertionIds: [], projectionIds: [], renderedTokenCount: 0,
    });
    assert.deepEqual(graph.retrievalUsage.listRecent('other_owner', 10), []);
    database.prepare('UPDATE retrieval_usage SET assertion_ids_json = ? WHERE id = ?')
      .run('{"not":"an array"}', usage.id);
    assert.throws(
      () => graph.retrievalUsage.readAssertionIds(graph.retrievalUsage.requireUsage(usage.id)),
      /Invalid input/,
    );
  });
});

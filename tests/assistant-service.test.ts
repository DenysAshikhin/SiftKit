import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import { AssistantService } from '../src/assistant/assistant-service.js';
import { FixedClock } from '../src/assistant/clock.js';
import { SequentialIdGenerator } from '../src/assistant/ids.js';
import { FileKeyProvider } from '../src/assistant/crypto/key-provider.js';
import { assistantKeyFile } from '../src/assistant/layout.js';
import { EstimateTokenCounter } from '../src/assistant/domain/tokens.js';
import { FakeAssistantInference } from './helpers/assistant-inference-fake.js';
import { closeRuntimeDatabase, getRuntimeDatabase } from '../src/state/runtime-db.js';
import { createManagedTempDir } from './helpers/temp-dirs.js';

class AlwaysIdle {
  isIdle(): boolean {
    return true;
  }
}

function buildService(responses: readonly string[]): AssistantService {
  const runtimeRoot = createManagedTempDir('siftkit-assistant-service-');
  return AssistantService.create({
    database: getRuntimeDatabase(path.join(runtimeRoot, 'runtime.sqlite')),
    runtimeRoot,
    clock: new FixedClock('2026-08-05T09:00:00.000Z'),
    ids: new SequentialIdGenerator(),
    keys: new FileKeyProvider(assistantKeyFile(runtimeRoot)),
    inference: new FakeAssistantInference(responses),
    tokens: new EstimateTokenCounter(4),
    idleGate: new AlwaysIdle(),
  });
}

test('the service creates the owner person node exactly once', () => {
  try {
    const service = buildService([]);
    const first = service.ownerPersonNodeId;
    assert.ok(first.length > 0);
    assert.equal(service.ownerPersonNodeId, first);
    assert.equal(
      service.graph.nodes.listNodesByType(service.ownerId, 'person').length, 1,
    );
  } finally {
    closeRuntimeDatabase();
  }
});

test('a chat turn is ingested without any model call', () => {
  try {
    const service = buildService([]);
    service.ingestChatTurn({
      ownerId: service.ownerId, sessionId: 'chat_1',
      capturedAtUtc: '2026-08-05T09:00:00.000Z',
      userMessageId: 'm1', userText: 'I use PowerShell.',
      assistantMessageId: 'm2', assistantText: 'Noted.',
    });
    assert.equal(service.graph.jobs.countByStatus(service.ownerId, 'queued'), 2);
    assert.equal(service.graph.evidence.countEvidence(service.ownerId), 2);
  } finally {
    closeRuntimeDatabase();
  }
});

test('retrieval on an empty graph returns an empty block', async () => {
  try {
    const service = buildService([]);
    const result = await service.retrieveMemoryContext('what shell do I use?');
    assert.equal(result.renderedBlock, '');
  } finally {
    closeRuntimeDatabase();
  }
});

test('an ingestion failure never throws at the caller', () => {
  try {
    const service = buildService([]);
    assert.doesNotThrow(() => {
      service.ingestChatTurn({
        ownerId: service.ownerId, sessionId: 'chat_1',
        capturedAtUtc: 'not-a-date',
        userMessageId: 'm1', userText: 'I use PowerShell.',
        assistantMessageId: 'm2', assistantText: 'Noted.',
      });
    });
  } finally {
    closeRuntimeDatabase();
  }
});

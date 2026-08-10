import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import { AssistantService } from '../src/assistant/assistant-service.js';
import { FixedClock } from '../src/assistant/clock.js';
import { EstimateTokenCounter } from '../src/assistant/domain/tokens.js';
import { SequentialIdGenerator } from '../src/assistant/ids.js';
import { FileKeyProvider } from '../src/assistant/crypto/key-provider.js';
import { assistantKeyFile } from '../src/assistant/layout.js';
import { ChatMemorySeam } from '../src/status-server/chat-memory-seam.js';
import { buildChatSystemContent } from '../src/status-server/chat.js';
import { LIVE_ASSERTION_STATUSES } from '../src/assistant/storage/assertion-store.js';
import { FakeAssistantInference } from './helpers/assistant-inference-fake.js';
import { closeRuntimeDatabase, getRuntimeDatabase } from '../src/state/runtime-db.js';
import { createManagedTempDir } from './helpers/temp-dirs.js';
import { mockModelPreset, mockSiftConfig } from './helpers/mock-config.js';
import { PresetCatalog } from '../src/preset-catalog.js';
import type { ChatSession } from '../src/state/chat-sessions.js';

class AlwaysIdle {
  isIdle(): boolean {
    return true;
  }
}

function statement(kind: 'direct_fact' | 'correction', objectName: string): string {
  return JSON.stringify({
    statements: [{
      statementKind: kind,
      subject: { nodeType: 'person', displayName: 'the user' },
      predicate: 'PREFERS',
      object: { kind: 'unresolved', nodeType: 'software', displayName: objectName },
      scope: null, validFromUtc: null, validToUtc: null,
      rationale: `The user said ${objectName}.`, suggestedConfidence: 0.9,
    }],
  });
}

const empty = JSON.stringify({ statements: [] });

function buildService(responses: readonly string[], clock: FixedClock): AssistantService {
  const runtimeRoot = createManagedTempDir('siftkit-gate-b-');
  return AssistantService.create({
    database: getRuntimeDatabase(path.join(runtimeRoot, 'runtime.sqlite')),
    runtimeRoot,
    clock,
    ids: new SequentialIdGenerator(),
    keys: new FileKeyProvider(assistantKeyFile(runtimeRoot)),
    inference: new FakeAssistantInference(responses),
    tokens: new EstimateTokenCounter(4),
    idleGate: new AlwaysIdle(),
  });
}

async function drainAllJobs(service: AssistantService): Promise<void> {
  for (let pass = 0; pass < 20; pass += 1) {
    if (service.graph.jobs.countByStatus(service.ownerId, 'queued') === 0) {
      return;
    }
    await service.drainJobs();
  }
  throw new Error('Assistant jobs did not drain within 20 passes.');
}

const basePreset = PresetCatalog.createDefault().requireById('summary');
const optedIn = { ...basePreset, id: 'in', assistantMemory: true };
const optedOut = { ...basePreset, id: 'out', assistantMemory: false };
const SESSION: ChatSession = {
  id: 'chat_1',
  modelPresetId: 'default',
  modelPreset: mockModelPreset({ id: 'default' }),
};

test('Gate B: conversation, correction, projection, retrieval, and opt-out work end to end', async () => {
  const clock = new FixedClock('2026-08-05T09:00:00.000Z');
  const service = buildService(
    [statement('direct_fact', 'PowerShell'), empty, statement('correction', 'Bash'), empty],
    clock,
  );
  try {
    const seam = new ChatMemorySeam(service);

    seam.ingestTurn(optedIn, {
      sessionId: 'chat_1', capturedAtUtc: clock.nowUtc(),
      userMessageId: 'm1', userText: 'I prefer PowerShell.',
      assistantMessageId: 'm2', assistantText: 'Understood.',
    });
    await drainAllJobs(service);
    const owner = service.ownerPersonNodeId;
    const afterFirst = service.graph.assertions
      .listBySubject(service.ownerId, owner, LIVE_ASSERTION_STATUSES)
      .filter((row) => row.predicate === 'PREFERS');
    assert.equal(afterFirst.length, 1, 'the conversation produced one live assertion');
    const firstId = afterFirst[0]?.id ?? '';

    const profile = service.graph.projections.findByTopic(service.ownerId, 1, 'profile');
    assert.notEqual(profile, null);
    assert.ok(profile?.content.includes('Prefers PowerShell'));
    assert.ok(profile?.content.includes(`[M:${firstId}]`), 'every projected line is cited');
    const hashBefore = profile?.content_hash;

    clock.advanceSeconds(600);
    seam.ingestTurn(optedIn, {
      sessionId: 'chat_1', capturedAtUtc: clock.nowUtc(),
      userMessageId: 'm3', userText: 'No, I meant Bash.',
      assistantMessageId: 'm4', assistantText: 'Updated.',
    });
    await drainAllJobs(service);
    assert.equal(service.graph.assertions.requireAssertion(firstId).status, 'superseded');
    const afterCorrection = service.graph.assertions
      .listBySubject(service.ownerId, owner, LIVE_ASSERTION_STATUSES)
      .filter((row) => row.predicate === 'PREFERS');
    assert.equal(afterCorrection.length, 1, 'the correction did not create a coequal fact');

    const refreshed = service.graph.projections.findByTopic(service.ownerId, 1, 'profile');
    assert.notEqual(refreshed?.content_hash, hashBefore, 'the projection was recompiled');
    assert.ok(refreshed?.content.includes('Prefers Bash'));
    assert.ok(!refreshed?.content.includes('Prefers PowerShell'));

    const injected = await seam.buildMemoryContext(optedIn, 'do I prefer Bash?');
    assert.ok(injected.includes('## Relevant personal context'));
    assert.ok(injected.includes('Prefers Bash'));
    assert.ok(/\[M:[a-z0-9_]+\]/.test(injected), 'every retrieved line carries its memory id');

    assert.equal(await seam.buildMemoryContext(optedOut, 'do I prefer Bash?'), '');
    const config = mockSiftConfig({});
    assert.equal(
      buildChatSystemContent(config, SESSION, {}),
      buildChatSystemContent(config, SESSION),
      'an opted-out prompt is byte-identical to today',
    );
  } finally {
    closeRuntimeDatabase();
  }
});

test('Gate B: SiftKit stays usable when the assistant fails to start', async () => {
  const seam = new ChatMemorySeam(null);
  assert.equal(await seam.buildMemoryContext(optedIn, 'anything'), '');
  assert.doesNotThrow(() => {
    seam.ingestTurn(optedIn, {
      sessionId: 'chat_1', capturedAtUtc: '2026-08-05T09:00:00.000Z',
      userMessageId: 'm1', userText: 'hi', assistantMessageId: 'm2', assistantText: 'hello',
    });
  });
  const config = mockSiftConfig({});
  assert.equal(
    buildChatSystemContent(config, SESSION, { memoryContext: '' }),
    buildChatSystemContent(config, SESSION),
  );
});

test('Gate B: replaying a turn adds no second assertion', async () => {
  const clock = new FixedClock('2026-08-05T09:00:00.000Z');
  const service = buildService([statement('direct_fact', 'PowerShell'), empty], clock);
  try {
    const seam = new ChatMemorySeam(service);
    const turn = {
      sessionId: 'chat_1', capturedAtUtc: clock.nowUtc(),
      userMessageId: 'm1', userText: 'I prefer PowerShell.',
      assistantMessageId: 'm2', assistantText: 'Understood.',
    };
    seam.ingestTurn(optedIn, turn);
    seam.ingestTurn(optedIn, turn);
    await drainAllJobs(service);
    assert.equal(service.graph.evidence.countEvidence(service.ownerId), 2);
    assert.equal(
      service.graph.assertions
        .listBySubject(service.ownerId, service.ownerPersonNodeId, LIVE_ASSERTION_STATUSES)
        .filter((row) => row.predicate === 'PREFERS').length,
      1,
    );
  } finally {
    closeRuntimeDatabase();
  }
});

import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import { AssistantService } from '../src/assistant/assistant-service.js';
import { FixedClock } from '../src/assistant/clock.js';
import { EstimateTokenCounter } from '../src/assistant/domain/tokens.js';
import { SequentialIdGenerator } from '../src/assistant/ids.js';
import { DEFAULT_ASSISTANT_CONFIG } from '../src/config/defaults.js';
import { closeRuntimeDatabase, getRuntimeDatabase } from '../src/state/runtime-db.js';
import { FakeAssistantInference } from './helpers/assistant-inference-fake.js';
import { MemoryAssistantConfigWriter } from './helpers/assistant-fixture.js';
import { createManagedTempDir, removeDirectoryWithRetries } from './helpers/temp-dirs.js';

class AlwaysIdle {
  isIdle(): boolean { return true; }
}

const ANSWER_EXTRACTION = JSON.stringify({ statements: [{
  statementKind: 'direct_fact',
  subject: { nodeType: 'person', displayName: 'the user' },
  predicate: 'PREFERS',
  object: { kind: 'unresolved', nodeType: 'topic', displayName: 'concise answers' },
  scope: null,
  validFromUtc: null,
  validToUtc: null,
  rationale: 'The user explicitly answered the question.',
  suggestedConfidence: 0.98,
}] });

async function drainAll(service: AssistantService): Promise<void> {
  for (let pass = 0; pass < 12; pass += 1) {
    if (service.graph.jobs.countByStatus(service.ownerId, 'queued') === 0) return;
    await service.drainJobs();
  }
  throw new Error('Gate C jobs did not drain.');
}

test('Gate C: an explicit question answer becomes controllable memory and signed forget removes it', async () => {
  const runtimeRoot = createManagedTempDir('siftkit-gate-c-');
  const clock = new FixedClock('2026-08-05T09:00:00.000Z');
  const inference = new FakeAssistantInference([ANSWER_EXTRACTION]);
  const config = { ...DEFAULT_ASSISTANT_CONFIG, Enabled: true };
  const service = AssistantService.create({
    database: getRuntimeDatabase(path.join(runtimeRoot, 'runtime.sqlite')),
    runtimeRoot,
    clock,
    ids: new SequentialIdGenerator(),
    configWriter: new MemoryAssistantConfigWriter(config),
    inference,
    tokens: new EstimateTokenCounter(4),
    idleGate: new AlwaysIdle(),
    config,
  });

  try {
    const question = service.graph.questions.create({
      ownerId: service.ownerId,
      topicKey: 'writing-style',
      questionText: 'Do you prefer concise answers?',
      questionType: 'confirm_inference',
      candidateIds: [],
      expectedValue: 0.9,
      interruptionCost: 0.1,
      eligibleAfterUtc: null,
      expiresAtUtc: '2026-08-12T09:00:00.000Z',
    });
    service.graph.questions.markEligible(question.id, clock.nowUtc());
    assert.equal(service.currentQuestion()?.id, question.id);

    const answer = service.questionFeedback.answer({
      ownerId: service.ownerId,
      questionId: question.id,
      answer: 'Yes, I prefer concise answers.',
    });
    assert.equal(answer.kind, 'accepted');
    await drainAll(service);

    const search = service.memoryQueries.search(service.ownerId, 'concise', 20);
    assert.equal(search.assertions.length, 1);
    const assertion = search.assertions[0];
    if (assertion === undefined) throw new Error('Expected promoted assertion.');
    assert.equal(assertion.basis, 'explicit_question_answer');
    assert.ok(search.projections.some((projection) => projection.content.includes('concise answers')));
    assert.equal(inference.requests.length, 1);
    assert.equal(typeof inference.requests[0]?.userText, 'string');

    service.memoryMutations.confirm({
      ownerId: service.ownerId, assertionId: assertion.id, reason: 'Confirmed in inspector.',
    });
    service.memoryMutations.setPinned({
      ownerId: service.ownerId, assertionId: assertion.id, pinned: true,
      reason: 'Important preference.',
    });
    service.memoryMutations.demote({
      ownerId: service.ownerId, assertionId: assertion.id, reason: 'Less relevant now.',
    });
    assert.ok(service.memoryQueries.explainAssertion(service.ownerId, assertion.id).kind === 'found');

    const stale = service.memoryMutations.previewForgetAssertion(service.ownerId, assertion.id);
    service.memoryMutations.setPinned({
      ownerId: service.ownerId, assertionId: assertion.id, pinned: true,
      reason: 'Change graph after preview.',
    });
    assert.throws(
      () => service.memoryMutations.confirmForgetAssertion(
        service.ownerId, assertion.id, stale.previewToken,
      ),
      /stale|graph/i,
    );
    const fresh = service.memoryMutations.previewForgetAssertion(service.ownerId, assertion.id);
    service.memoryMutations.confirmForgetAssertion(
      service.ownerId, assertion.id, fresh.previewToken,
    );
    await drainAll(service);
    assert.equal(service.memoryQueries.search(service.ownerId, 'concise', 20).assertions.length, 0);
    assert.ok(
      service.memoryQueries.listMemoryHistory(service.ownerId, { limit: 100, offset: 0 })
        .length >= 5,
    );
  } finally {
    closeRuntimeDatabase();
    await removeDirectoryWithRetries(runtimeRoot);
  }
});

test('Gate C: disabled service remains inert and unavailable desktop state never shows a question', async () => {
  const runtimeRoot = createManagedTempDir('siftkit-gate-c-disabled-');
  const config = { ...DEFAULT_ASSISTANT_CONFIG, Enabled: false };
  const service = AssistantService.create({
    database: getRuntimeDatabase(path.join(runtimeRoot, 'runtime.sqlite')),
    runtimeRoot,
    clock: new FixedClock('2026-08-05T09:00:00.000Z'),
    ids: new SequentialIdGenerator(),
    configWriter: new MemoryAssistantConfigWriter(config),
    inference: new FakeAssistantInference([]),
    tokens: new EstimateTokenCounter(4),
    idleGate: new AlwaysIdle(),
    config,
  });
  try {
    service.ingestChatTurn({
      ownerId: service.ownerId, sessionId: 'disabled',
      capturedAtUtc: '2026-08-05T09:00:00.000Z',
      userMessageId: 'u', userText: 'remember this',
      assistantMessageId: 'a', assistantText: 'okay',
    });
    await service.drainJobs();
    assert.equal(service.graph.evidence.countEvidence(service.ownerId), 0);
    assert.equal(service.currentQuestion(), null);
    assert.equal((await service.retrieveMemoryContext('remember')).renderedBlock, '');
  } finally {
    closeRuntimeDatabase();
    await removeDirectoryWithRetries(runtimeRoot);
  }
});

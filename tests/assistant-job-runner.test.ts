import test from 'node:test';
import assert from 'node:assert/strict';

import { AssistantJobRunner } from '../src/assistant/jobs/job-runner.js';
import { CandidateGate } from '../src/assistant/ingestion/candidate-gate.js';
import { CandidateConsolidator } from '../src/assistant/ingestion/consolidator.js';
import { CandidatePromoter } from '../src/assistant/ingestion/candidate-promoter.js';
import { ConversationExtractor } from '../src/assistant/ingestion/conversation-extractor.js';
import { IngestionPipeline } from '../src/assistant/ingestion/pipeline.js';
import { ConversationIngestor } from '../src/assistant/ingestion/conversation-ingestor.js';
import { ProjectionCompiler } from '../src/assistant/projections/projection-compiler.js';
import { StructuredOutputRunner } from '../src/assistant/inference/structured-runner.js';
import type { AssistantInferenceRequest } from '../src/assistant/inference/client.js';
import { SecretScanner } from '../src/assistant/domain/secrets.js';
import { EstimateTokenCounter } from '../src/assistant/domain/tokens.js';
import { OWNER_PERSON_CANONICAL_KEY } from '../src/assistant/storage/schema.js';
import { FakeAssistantInference } from './helpers/assistant-inference-fake.js';
import { withAssistantContextAsync } from './helpers/assistant-fixture.js';

class StaticIdleGate {
  constructor(private idle: boolean) {}

  isIdle(): boolean {
    return this.idle;
  }

  setIdle(idle: boolean): void {
    this.idle = idle;
  }
}

const usesPowerShell = JSON.stringify({
  statements: [{
    statementKind: 'direct_fact',
    subject: { nodeType: 'person', displayName: 'the user' },
    predicate: 'USES',
    object: { kind: 'unresolved', nodeType: 'software', displayName: 'PowerShell' },
    scope: null, validFromUtc: null, validToUtc: null,
    rationale: 'The user wrote "I use PowerShell".', suggestedConfidence: 0.9,
  }],
});

test('draining a queued conversation job produces an assertion and a projection', async () => {
  await withAssistantContextAsync(async ({ graph, ownerId }) => {
    const owner = graph.nodes.createNode({
      ownerId, type: 'person', canonicalKey: OWNER_PERSON_CANONICAL_KEY,
      displayName: 'the user', description: null, sensitivity: 'personal', properties: {},
    });
    graph.nodes.addAlias({
      ownerId, nodeId: owner.id, alias: 'the user',
      aliasType: 'user_supplied', sourceEvidenceId: null,
    });
    const pipeline = new IngestionPipeline(graph, new SecretScanner());
    new ConversationIngestor(pipeline).ingestTurn({
      ownerId, sessionId: 'chat_1', capturedAtUtc: '2026-08-05T09:00:00.000Z',
      userMessageId: 'm1', userText: 'I use PowerShell.',
      assistantMessageId: 'm2', assistantText: '',
    });
    const inference = new FakeAssistantInference([usesPowerShell]);
    const runner = new AssistantJobRunner({
      graph,
      extractor: new ConversationExtractor(graph, new StructuredOutputRunner(inference)),
      promoter: new CandidatePromoter(graph, new CandidateGate(graph.policies, new SecretScanner())),
      consolidator: new CandidateConsolidator(graph, new StructuredOutputRunner(inference)),
      projections: new ProjectionCompiler(graph, new EstimateTokenCounter(4)),
      idleGate: new StaticIdleGate(true),
      leaseOwner: 'runner_test',
      leaseSeconds: 120,
    });

    const summary = await runner.drain(ownerId, 10);
    assert.ok(summary.completed >= 1);
    assert.equal(graph.jobs.countByStatus(ownerId, 'queued'), 0);
    assert.equal(graph.jobs.countByStatus(ownerId, 'failed'), 0);
    const ownerPerson = graph.nodes.findByCanonicalKey(
      ownerId, 'person', OWNER_PERSON_CANONICAL_KEY,
    );
    assert.notEqual(ownerPerson, null);
    assert.ok(
      graph.assertions.listBySubject(ownerId, ownerPerson?.id ?? '', ['active']).length >= 1,
    );
    assert.ok(graph.projections.listAll(ownerId).length >= 1);
  });
});

test('a busy host claims nothing', async () => {
  await withAssistantContextAsync(async ({ graph, ownerId }) => {
    const pipeline = new IngestionPipeline(graph, new SecretScanner());
    new ConversationIngestor(pipeline).ingestTurn({
      ownerId, sessionId: 'chat_1', capturedAtUtc: '2026-08-05T09:00:00.000Z',
      userMessageId: 'm1', userText: 'I use PowerShell.',
      assistantMessageId: 'm2', assistantText: '',
    });
    const inference = new FakeAssistantInference([]);
    const runner = new AssistantJobRunner({
      graph,
      extractor: new ConversationExtractor(graph, new StructuredOutputRunner(inference)),
      promoter: new CandidatePromoter(graph, new CandidateGate(graph.policies, new SecretScanner())),
      consolidator: new CandidateConsolidator(graph, new StructuredOutputRunner(inference)),
      projections: new ProjectionCompiler(graph, new EstimateTokenCounter(4)),
      idleGate: new StaticIdleGate(false),
      leaseOwner: 'runner_test',
      leaseSeconds: 120,
    });
    const summary = await runner.drain(ownerId, 10);
    assert.equal(summary.claimed, 0);
    assert.equal(graph.jobs.countByStatus(ownerId, 'queued'), 1);
  });
});

test('preemption returns the job to the queue without spending an attempt', async () => {
  await withAssistantContextAsync(async ({ graph, ownerId }) => {
    const pipeline = new IngestionPipeline(graph, new SecretScanner());
    new ConversationIngestor(pipeline).ingestTurn({
      ownerId, sessionId: 'chat_1', capturedAtUtc: '2026-08-05T09:00:00.000Z',
      userMessageId: 'm1', userText: 'I use PowerShell.',
      assistantMessageId: 'm2', assistantText: '',
    });

    class PreemptingInference extends FakeAssistantInference {
      private runner: AssistantJobRunner | null = null;

      constructor(private readonly idleGate: StaticIdleGate) {
        super([usesPowerShell]);
      }

      attachRunner(runner: AssistantJobRunner): void {
        this.runner = runner;
      }

      async complete(request: AssistantInferenceRequest) {
        this.idleGate.setIdle(false);
        this.runner?.requestPreemption();
        if (request.abortSignal?.aborted === true) {
          throw new Error('Assistant inference aborted by interactive work.');
        }
        return super.complete(request);
      }
    }

    const idleGate = new StaticIdleGate(true);
    const inference = new PreemptingInference(idleGate);
    const runner = new AssistantJobRunner({
      graph,
      extractor: new ConversationExtractor(graph, new StructuredOutputRunner(inference)),
      promoter: new CandidatePromoter(graph, new CandidateGate(graph.policies, new SecretScanner())),
      consolidator: new CandidateConsolidator(
        graph, new StructuredOutputRunner(new FakeAssistantInference([])),
      ),
      projections: new ProjectionCompiler(graph, new EstimateTokenCounter(4)),
      idleGate,
      leaseOwner: 'runner_test',
      leaseSeconds: 120,
    });
    inference.attachRunner(runner);

    const summary = await runner.drain(ownerId, 10);
    assert.equal(summary.preempted, 1);
    assert.equal(graph.jobs.countByStatus(ownerId, 'queued'), 1);
    const queued = graph.jobs.listByStatus(ownerId, 'queued')[0];
    assert.equal(queued?.attempts, 0, 'preemption is not failure');
  });
});

test('a job whose evidence vanished fails and eventually dead-letters', async () => {
  await withAssistantContextAsync(async ({ graph, ownerId }) => {
    graph.jobs.enqueue({
      ownerId, jobType: 'conversation_ingestion',
      payload: { evidenceId: 'ev_missing', sessionId: 'chat_1' },
      idempotencyKey: 'conversation_ingestion:ev_missing',
    });
    const inference = new FakeAssistantInference([]);
    const runner = new AssistantJobRunner({
      graph,
      extractor: new ConversationExtractor(graph, new StructuredOutputRunner(inference)),
      promoter: new CandidatePromoter(graph, new CandidateGate(graph.policies, new SecretScanner())),
      consolidator: new CandidateConsolidator(graph, new StructuredOutputRunner(inference)),
      projections: new ProjectionCompiler(graph, new EstimateTokenCounter(4)),
      idleGate: new StaticIdleGate(true),
      leaseOwner: 'runner_test',
      leaseSeconds: 120,
    });
    const summary = await runner.drain(ownerId, 1);
    assert.equal(summary.failed, 1);
    assert.equal(graph.jobs.countByStatus(ownerId, 'queued'), 1);
    assert.equal(graph.jobs.listByStatus(ownerId, 'queued')[0]?.attempts, 1);
  });
});

test('recovery re-queues a lease abandoned by a crashed runner', async () => {
  await withAssistantContextAsync(async ({ graph, ownerId, clock }) => {
    graph.jobs.enqueue({
      ownerId, jobType: 'projection_maintenance',
      payload: { reason: 'startup' }, idempotencyKey: 'projection_maintenance:startup',
    });
    graph.jobs.claimNext({ ownerId, leaseOwner: 'crashed', leaseSeconds: 30 });
    clock.advanceSeconds(31);
    const inference = new FakeAssistantInference([]);
    const runner = new AssistantJobRunner({
      graph,
      extractor: new ConversationExtractor(graph, new StructuredOutputRunner(inference)),
      promoter: new CandidatePromoter(graph, new CandidateGate(graph.policies, new SecretScanner())),
      consolidator: new CandidateConsolidator(graph, new StructuredOutputRunner(inference)),
      projections: new ProjectionCompiler(graph, new EstimateTokenCounter(4)),
      idleGate: new StaticIdleGate(true),
      leaseOwner: 'runner_test',
      leaseSeconds: 120,
    });
    const summary = await runner.drain(ownerId, 5);
    assert.equal(summary.recovered, 1);
    assert.equal(graph.jobs.countByStatus(ownerId, 'completed'), 1);
  });
});

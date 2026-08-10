import assert from 'node:assert/strict';
import test from 'node:test';

import { EstimateTokenCounter } from '../src/assistant/domain/tokens.js';
import { StructuredOutputRunner } from '../src/assistant/inference/structured-runner.js';
import { ProjectionSummarizer } from '../src/assistant/projections/projection-summarizer.js';
import { ProjectionCompiler } from '../src/assistant/projections/projection-compiler.js';
import { FakeAssistantInference } from './helpers/assistant-inference-fake.js';
import { withAssistantContextAsync } from './helpers/assistant-fixture.js';

const ORIGINAL = '# Tools\n- Uses PowerShell daily. [M:ast_1]\n- Prefers Windows Terminal. [M:ast_2]';
const ASSERTIONS = [
  { assertionId: 'ast_1', sensitivity: 'personal' as const },
  { assertionId: 'ast_2', sensitivity: 'low' as const },
];

function effectiveBody(result: Awaited<ReturnType<ProjectionSummarizer['summarize']>>): string {
  return result.kind === 'summarized' ? result.body : ORIGINAL;
}

test('a valid cited compression is accepted and rendered with durable citations', async () => {
  const inference = new FakeAssistantInference([JSON.stringify({
    sentences: [{ text: 'Uses PowerShell with Windows Terminal.', assertionIds: ['ast_1', 'ast_2'] }],
  })]);
  const summarizer = new ProjectionSummarizer(
    new StructuredOutputRunner(inference),
    new EstimateTokenCounter(4),
  );
  const result = await summarizer.summarize({
    body: ORIGINAL, assertions: ASSERTIONS, targetTokens: 100,
  }, new AbortController().signal);
  assert.deepEqual(result, {
    kind: 'summarized',
    body: '- Uses PowerShell with Windows Terminal. [M:ast_1] [M:ast_2]',
    assertionIds: ['ast_1', 'ast_2'],
  });
  assert.equal(inference.requests[0]?.role, 'projection_summarizer');
});

test('malformed, unknown-citation, uncited-sentence, and overflowing results preserve the original', async () => {
  const cases = [
    ['{}', '{}'],
    [
      JSON.stringify({ sentences: [{ text: 'Unknown.', assertionIds: ['ast_missing'] }] }),
    ],
    [
      JSON.stringify({ sentences: [{ text: 'Cited. Uncited.', assertionIds: ['ast_1'] }] }),
    ],
    [
      JSON.stringify({ sentences: [{ text: 'This compression is deliberately much too long.', assertionIds: ['ast_1'] }] }),
    ],
  ] as const;
  for (const [index, responses] of cases.entries()) {
    const summarizer = new ProjectionSummarizer(
      new StructuredOutputRunner(new FakeAssistantInference(responses)),
      new EstimateTokenCounter(1),
    );
    const result = await summarizer.summarize({
      body: ORIGINAL,
      assertions: ASSERTIONS,
      targetTokens: index === 3 ? 2 : 100,
    }, new AbortController().signal);
    assert.equal(result.kind, 'unchanged');
    assert.equal(effectiveBody(result), ORIGINAL);
  }
});

test('sensitive assertion lines are excluded from inference and cannot be cited', async () => {
  const body = `${ORIGINAL}\n- Has a private health detail. [M:ast_secret]`;
  const inference = new FakeAssistantInference([JSON.stringify({
    sentences: [{ text: 'Uses PowerShell.', assertionIds: ['ast_1'] }],
  })]);
  const summarizer = new ProjectionSummarizer(
    new StructuredOutputRunner(inference),
    new EstimateTokenCounter(4),
  );
  const result = await summarizer.summarize({
    body,
    assertions: [...ASSERTIONS, { assertionId: 'ast_secret', sensitivity: 'sensitive' }],
    targetTokens: 100,
  }, new AbortController().signal);
  assert.equal(result.kind, 'summarized');
  assert.ok(!inference.requests[0]?.userText.includes('private health detail'));
});

test('abort and inference failure preserve the deterministic original', async () => {
  const abortedInference = new FakeAssistantInference([]);
  const aborted = new AbortController();
  aborted.abort();
  const abortedResult = await new ProjectionSummarizer(
    new StructuredOutputRunner(abortedInference),
    new EstimateTokenCounter(4),
  ).summarize({ body: ORIGINAL, assertions: ASSERTIONS, targetTokens: 100 }, aborted.signal);
  assert.equal(abortedResult.kind, 'unchanged');
  assert.equal(abortedInference.requests.length, 0);

  class FailingInference extends FakeAssistantInference {
    override async complete(): Promise<never> {
      throw new Error('backend unavailable');
    }
  }
  const failedResult = await new ProjectionSummarizer(
    new StructuredOutputRunner(new FailingInference([])),
    new EstimateTokenCounter(4),
  ).summarize({
    body: ORIGINAL, assertions: ASSERTIONS, targetTokens: 100,
  }, new AbortController().signal);
  assert.equal(failedResult.kind, 'unchanged');
  assert.equal(effectiveBody(failedResult), ORIGINAL);
});

test('the compiler summarizes only a newly changed over-target projection', async () => {
  await withAssistantContextAsync(async ({ graph, ownerId }) => {
    const person = graph.nodes.createNode({
      ownerId, type: 'person', canonicalKey: 'person:owner', displayName: 'the user',
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
      retentionUntilUtc: null, metadata: {}, text: 'I prefer PowerShell.',
    });
    const assertion = graph.assertionService.assert({
      ownerId, actorType: 'user', actorRef: null, subjectNodeId: person.id, predicate: 'PREFERS',
      object: { kind: 'node', nodeId: shell.id }, scopeNodeId: null,
      basis: 'explicit_user_statement', sensitivity: 'personal',
      validFromUtc: null, validToUtc: null, observedAtUtc: '2026-08-05T09:00:00.000Z',
      topics: [], attributes: {},
      searchText: { subject: 'the user', predicate: 'PREFERS', object: 'PowerShell', scope: '' },
      evidence: [{ evidenceId: evidence.id, stance: 'supports', weight: 1 }],
    });
    assert.equal(assertion.kind, 'created');
    if (assertion.kind !== 'created') return;
    const inference = new FakeAssistantInference([JSON.stringify({
      sentences: [{ text: 'Prefers PowerShell.', assertionIds: [assertion.assertionId] }],
    })]);
    const tokens = new EstimateTokenCounter(4);
    const compiler = new ProjectionCompiler(
      graph,
      tokens,
      new ProjectionSummarizer(new StructuredOutputRunner(inference), tokens),
      { 1: 1, 2: 1, 3: 1 },
    );
    const signal = new AbortController().signal;
    await compiler.compileAll(ownerId, signal);
    const first = graph.projections.findByTopic(ownerId, 1, 'profile');
    assert.ok(first?.content.includes('- Prefers PowerShell.'));
    assert.equal(inference.requests.length, 1);

    await compiler.compileAll(ownerId, signal);
    assert.equal(graph.projections.findByTopic(ownerId, 1, 'profile')?.content, first?.content);
    assert.equal(inference.requests.length, 1, 'unchanged graph versions never re-summarize');
  });
});

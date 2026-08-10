import assert from 'node:assert/strict';
import test from 'node:test';

import { ExplicitIntentParser } from '../src/assistant/retrieval/explicit-intent-parser.js';
import { StructuredOutputRunner } from '../src/assistant/inference/structured-runner.js';
import { FakeAssistantInference } from './helpers/assistant-inference-fake.js';

test('explicit intent parsing returns only a validated QueryIntent from text-only inference', async () => {
  const inference = new FakeAssistantInference([JSON.stringify({
    terms: ['powershell', 'windows'],
    temporal: { kind: 'current' },
    taskType: 'troubleshooting',
  })]);
  const parser = new ExplicitIntentParser(new StructuredOutputRunner(inference));
  const result = await parser.parse('Help debug my PowerShell setup', new AbortController().signal);
  assert.deepEqual(result, {
    terms: ['powershell', 'windows'],
    temporal: { kind: 'current' },
    taskType: 'troubleshooting',
  });
  assert.equal(inference.requests.length, 1);
  assert.equal(inference.requests[0]?.role, 'query_intent_parser');
  assert.equal(typeof inference.requests[0]?.userText, 'string');
});

test('explicit intent parsing makes one validated repair attempt and then fails loudly', async () => {
  const repairedInference = new FakeAssistantInference([
    '{"terms":[]}',
    JSON.stringify({ terms: ['history'], temporal: { kind: 'historical' }, taskType: 'recall' }),
  ]);
  const repaired = new ExplicitIntentParser(new StructuredOutputRunner(repairedInference));
  assert.equal((await repaired.parse('What did I use before?', new AbortController().signal)).temporal.kind, 'historical');
  assert.equal(repairedInference.requests.length, 2);

  const rejectedInference = new FakeAssistantInference(['{}', '{}']);
  const rejected = new ExplicitIntentParser(new StructuredOutputRunner(rejectedInference));
  await assert.rejects(
    rejected.parse('query', new AbortController().signal),
    /query intent.*rejected/i,
  );
  assert.equal(rejectedInference.requests.length, 2);
});

import test from 'node:test';
import assert from 'node:assert/strict';

import { ModelJson } from '../src/lib/model-json.js';
import { z } from '../src/lib/zod.js';

test('ModelJson parses valid summary decisions without repair', () => {
  const decision = ModelJson.parseSummaryDecision(JSON.stringify({
    classification: 'summary',
    raw_review_required: false,
    output: 'clean output',
  }));

  assert.deepEqual(decision, {
    classification: 'summary',
    rawReviewRequired: false,
    output: 'clean output',
  });
});

test('ModelJson repairs fenced summary decisions with trailing commas and missing braces', () => {
  const decision = ModelJson.parseSummaryDecision([
    '```json',
    '{',
    "  'classification': 'summary',",
    "  'raw_review_required': true,",
    "  'output': 'contains useful details',",
    '```',
  ].join('\n'));

  assert.deepEqual(decision, {
    classification: 'summary',
    rawReviewRequired: true,
    output: 'contains useful details',
  });
});

test('ModelJson repairs escaped JSON strings before validating tool arguments', () => {
  const args = ModelJson.parseToolArguments('"{\\"command\\":\\"rg -n plan src\\",}"');
  assert.deepEqual(args, { command: 'rg -n plan src' });
});

test('ModelJson rejects tool arguments when repair synthesizes a missing value', () => {
  assert.equal(ModelJson.parseToolArguments('{"command":}'), null);
});

test('ModelJson rejects invalid summary shape after repair', () => {
  assert.throws(
    () => ModelJson.parseSummaryDecision("{'classification':'nope','raw_review_required':false,'output':'x'}"),
    /invalid SiftKit decision classification/u,
  );
});

test('ModelJson parses a fenced typed object and rejects schema mismatches and synthesized values', () => {
  const schema = z.object({ decision: z.enum(['approve', 'deny']), reason: z.string().min(1) }).strict();
  assert.deepEqual(ModelJson.parseObject('```json\n{"decision":"approve","reason":"safe"}\n```', schema, 'approval decision'),
    { decision: 'approve', reason: 'safe' });
  assert.throws(() => ModelJson.parseObject('{"decision":"maybe","reason":"x"}', schema, 'approval decision'), /"decision"/u);
  assert.throws(() => ModelJson.parseObject('{"decision":"approve","reason":}', schema, 'approval decision'),
    /synthesized a missing value/u);
  assert.throws(() => ModelJson.parseObject('I approve this.', schema, 'approval decision'), /invalid approval decision payload/u);
});

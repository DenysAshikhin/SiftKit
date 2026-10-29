import test from 'node:test';
import assert from 'node:assert/strict';

import { ModelJson } from '../src/lib/model-json.ts';
import { z } from '../src/lib/zod.ts';
import { OrchestratorSavePlanArgsSchema } from '@siftkit/contracts';
import { makeOrchestratorPlan, makeOrchestratorTask } from './helpers/orchestrator-plan.ts';

const APPROVAL_DECISION = z.object({ decision: z.enum(['approve', 'deny']), reason: z.string().min(1) }).strict();

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

test('ModelJson reads a summary decision the same way as a typed answer: after prose or in a fence inside prose', () => {
  const answer = '{"classification":"summary","raw_review_required":false,"output":"two failures"}';
  const expected = { classification: 'summary', rawReviewRequired: false, output: 'two failures' };
  assert.deepEqual(ModelJson.parseSummaryDecision(`Here is my decision.\n${answer}`), expected);
  assert.deepEqual(ModelJson.parseSummaryDecision(`Decision:\n\`\`\`json\n${answer}\n\`\`\`\nDone.`), expected);
});

test('ModelJson repairs escaped JSON strings before validating tool arguments', () => {
  const args = ModelJson.parseToolArguments('"{\\"command\\":\\"rg -n plan src\\",}"');
  assert.deepEqual(args, { command: 'rg -n plan src' });
});

// A live orchestrator wrote `.\src/...` unescaped; repair dropped the backslash and every plan check ran `.src/...`.
test('ModelJson keeps raw Windows backslashes in a string that has an invalid escape', () => {
  assert.deepEqual(ModelJson.parseToolArguments(String.raw`{"command":"node .\src/test-runner/run-tests.ts orchestrator"}`),
    { command: String.raw`node .\src/test-runner/run-tests.ts orchestrator` });
  assert.deepEqual(ModelJson.parseToolArguments(String.raw`{"command":"node .\src\test-runner\run-tests.ts","cwd":"."}`),
    { command: String.raw`node .\src\test-runner\run-tests.ts`, cwd: '.' }, 'escape-like \\t and \\r stay literal, not a tab and a CR');
  assert.deepEqual(ModelJson.parseToolArguments(String.raw`{"path":"C:\Users\denys\x.ts","note":"say \"hi\""}`),
    { path: String.raw`C:\Users\denys\x.ts`, note: 'say "hi"' }, 'an invalid \\U escape marks the string as raw');
});

test('ModelJson leaves valid escapes alone in strings without an invalid one', () => {
  assert.deepEqual(ModelJson.parseToolArguments(String.raw`{"command":"node .\src/run.ts","instruction":"line one\nline two\t\"x\""}`),
    { command: String.raw`node .\src/run.ts`, instruction: 'line one\nline two\t"x"' });
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
  assert.throws(() => ModelJson.parseObject('{"decision":"maybe","reason":"x"}', schema, 'approval decision'), /at decision/u);
  assert.throws(() => ModelJson.parseObject('{"decision":"approve","reason":}', schema, 'approval decision'),
    /synthesized a missing value/u);
  assert.throws(() => ModelJson.parseObject('I approve this.', schema, 'approval decision'), /invalid approval decision payload/u);
});

test('ModelJson takes the answer object after prose or inside a fence surrounded by prose', () => {
  assert.deepEqual(ModelJson.parseObject('Confirmed: harmless.\n{"decision":"approve","reason":"read-only"}',
    APPROVAL_DECISION, 'approval decision'), { decision: 'approve', reason: 'read-only' });
  assert.deepEqual(ModelJson.parseObject('Here it is:\n```json\n{"decision":"deny","reason":"writes"}\n```\nDone.',
    APPROVAL_DECISION, 'approval decision'), { decision: 'deny', reason: 'writes' });
});

test('ModelJson drops keys the schema does not define, at any depth, and keeps validating values', () => {
  const plan = makeOrchestratorPlan([makeOrchestratorTask()]);
  const noisy = { notes: 'extra',
    plan: { ...plan, tasks: plan.tasks.map((task) => ({ ...task, steps: task.steps.map((step) => ({ ...step, evidence: 'x' })) })) } };
  assert.deepEqual(ModelJson.parseObject(JSON.stringify(noisy), OrchestratorSavePlanArgsSchema, 'save_plan'), { plan });
  assert.throws(() => ModelJson.parseObject(JSON.stringify(plan), OrchestratorSavePlanArgsSchema, 'save_plan'),
    /plan/u, 'a bare plan without its {plan} wrapper is still rejected');
  assert.throws(() => ModelJson.parseObject('{"decision":"maybe","reason":"x","notes":"y"}', APPROVAL_DECISION,
    'approval decision'), /decision/u, 'a wrong value is still rejected even with an extra key');
});

test('ModelJson names the payload and reports schema problems readably, not as raw issue JSON', () => {
  assert.throws(() => ModelJson.parseObject('{"decision":"maybe","reason":"x"}', APPROVAL_DECISION, 'approval decision'),
    (error: Error) => error.message.startsWith('Provider returned an invalid approval decision payload: ')
      && /decision/u.test(error.message) && !error.message.includes('"code"'));
});

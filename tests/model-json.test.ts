import test from 'node:test';
import assert from 'node:assert/strict';

import { ModelJson } from '../src/lib/model-json.js';

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

test('ModelJson repairs missing commas in summary planner actions', () => {
  const action = ModelJson.parseSummaryPlannerAction(
    '{"action":"finish" "classification":"summary" "raw_review_required":false "output":"done"}',
  );

  assert.deepEqual(action, {
    action: 'finish',
    classification: 'summary',
    rawReviewRequired: false,
    output: 'done',
  });
});

test('ModelJson repairs escaped JSON strings before validating tool arguments', () => {
  const args = ModelJson.parseToolArguments('"{\\"command\\":\\"rg -n plan src\\",}"');

  assert.deepEqual(args, {
    command: 'rg -n plan src',
  });
});

test('ModelJson rejects invalid summary shape after repair', () => {
  assert.throws(
    () => ModelJson.parseSummaryDecision("{'classification':'nope','raw_review_required':false,'output':'x'}"),
    /invalid SiftKit decision classification/u,
  );
});

test('ModelJson rejects unknown repo-search tools after repair', () => {
  assert.throws(
    () => ModelJson.parseRepoSearchPlannerAction(
      "{'action':'tool','tool_name':'repo_delete_everything','args':{'command':'echo no'}}",
      { allowedToolNames: ['repo_rg'] },
    ),
    /invalid planner tool action/u,
  );
});

test('ModelJson rejects unrecoverable model JSON', () => {
  assert.throws(
    () => ModelJson.parseSummaryDecision('this is not json'),
    /Provider returned an invalid SiftKit decision payload/u,
  );
});

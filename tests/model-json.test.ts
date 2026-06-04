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

test('ModelJson extracts decoded output from a complete streaming finish action', () => {
  const output = ModelJson.extractStreamingFinishOutput(
    '{"action":"finish","output":"Line one\\nLine two"}',
  );

  assert.equal(output, 'Line one\nLine two');
});

test('ModelJson extracts the decoded prefix while a finish output is still streaming', () => {
  const output = ModelJson.extractStreamingFinishOutput(
    '{"action":"finish","output":"Tool calls are handled\\n- Backend',
  );

  assert.equal(output, 'Tool calls are handled\n- Backend');
});

test('ModelJson decodes escaped quotes inside a streaming finish output', () => {
  const output = ModelJson.extractStreamingFinishOutput(
    '{"action":"finish","output":"He said \\"hi\\" loudly"}',
  );

  assert.equal(output, 'He said "hi" loudly');
});

test('ModelJson ignores a trailing incomplete escape in a streaming finish output', () => {
  const output = ModelJson.extractStreamingFinishOutput(
    '{"action":"finish","output":"first line\\',
  );

  assert.equal(output, 'first line');
});

test('ModelJson returns null for a streaming tool action (no finish output)', () => {
  const output = ModelJson.extractStreamingFinishOutput(
    '{"action":"repo_read_file","args":{"path":"a.ts"}}',
  );

  assert.equal(output, null);
});

test('ModelJson returns null before the finish output key has streamed', () => {
  const output = ModelJson.extractStreamingFinishOutput('{"action":"finish"');

  assert.equal(output, null);
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

test('ModelJson parses direct summary planner tool actions', () => {
  const action = ModelJson.parseSummaryPlannerAction(JSON.stringify({
    action: 'read_lines',
    startLine: 10,
    endLine: 25,
  }));

  assert.deepEqual(action, {
    action: 'tool',
    tool_name: 'read_lines',
    args: {
      startLine: 10,
      endLine: 25,
    },
  });
});

test('ModelJson rejects wrapped summary planner tool actions', () => {
  assert.throws(
    () => ModelJson.parseSummaryPlannerAction(JSON.stringify({
      action: 'tool',
      tool_name: 'read_lines',
      args: {
        startLine: 10,
        endLine: 25,
      },
    })),
    /unknown planner action/u,
  );
});

test('ModelJson parses direct repo-search planner tool actions', () => {
  const action = ModelJson.parseRepoSearchPlannerAction(JSON.stringify({
    action: 'repo_rg',
    command: 'rg -n "plan" src',
  }), { allowedToolNames: ['repo_rg'] });

  assert.deepEqual(action, {
    action: 'tool',
    tool_name: 'repo_rg',
    args: {
      command: 'rg -n "plan" src',
    },
  });
});

test('ModelJson rejects wrapped repo-search planner tool actions', () => {
  assert.throws(
    () => ModelJson.parseRepoSearchPlannerAction(JSON.stringify({
      action: 'tool',
      tool_name: 'repo_rg',
      args: {
        command: 'rg -n "plan" src',
      },
    }), { allowedToolNames: ['repo_rg'] }),
    /unknown planner action/u,
  );
});

test('ModelJson rejects unknown repo-search tools after repair', () => {
  assert.throws(
    () => ModelJson.parseRepoSearchPlannerAction(
      "{'action':'repo_delete_everything','command':'echo no'}",
      { allowedToolNames: ['repo_rg'] },
    ),
    /unknown planner action/u,
  );
});

test('ModelJson rejects unrecoverable model JSON', () => {
  assert.throws(
    () => ModelJson.parseSummaryDecision('this is not json'),
    /Provider returned an invalid SiftKit decision payload/u,
  );
});

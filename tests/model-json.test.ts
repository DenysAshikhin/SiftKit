import test from 'node:test';
import assert from 'node:assert/strict';

import { ModelJson } from '../src/lib/model-json.js';
import {
  getRepoSearchToolNamesForParsing,
  resolveRepoSearchPlannerToolDefinitions,
} from '../src/repo-search/planner-protocol.js';
import { buildPlannerToolDefinitions } from '../src/summary/planner/tools.js';

const SUMMARY_TOOL_DEFINITIONS = buildPlannerToolDefinitions();

function parseSummaryPlannerAction(text: string) {
  return ModelJson.parseSummaryPlannerAction(text, {
    toolDefinitions: SUMMARY_TOOL_DEFINITIONS,
  });
}

function parseRepoSearchPlannerAction(
  text: string,
  allowedToolNames: readonly string[] = getRepoSearchToolNamesForParsing(),
) {
  return ModelJson.parseRepoSearchPlannerAction(text, {
    toolDefinitions: resolveRepoSearchPlannerToolDefinitions(allowedToolNames),
  });
}

test('ModelJson parses valid summary decisions without repair', () => {
  const decision = ModelJson.parseSummaryDecision(
    JSON.stringify({
      classification: 'summary',
      raw_review_required: false,
      output: 'clean output',
    }),
  );

  assert.deepEqual(decision, {
    classification: 'summary',
    rawReviewRequired: false,
    output: 'clean output',
  });
});

test('ModelJson repairs fenced summary decisions with trailing commas and missing braces', () => {
  const decision = ModelJson.parseSummaryDecision(
    [
      '```json',
      '{',
      "  'classification': 'summary',",
      "  'raw_review_required': true,",
      "  'output': 'contains useful details',",
      '```',
    ].join('\n'),
  );

  assert.deepEqual(decision, {
    classification: 'summary',
    rawReviewRequired: true,
    output: 'contains useful details',
  });
});

test('ModelJson repairs missing commas in summary planner actions', () => {
  const action = parseSummaryPlannerAction(
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
  const output = ModelJson.extractStreamingFinishOutput('{"action":"finish","output":"Line one\\nLine two"}');

  assert.equal(output, 'Line one\nLine two');
});

test('ModelJson extracts the decoded prefix while a finish output is still streaming', () => {
  const output = ModelJson.extractStreamingFinishOutput(
    '{"action":"finish","output":"Tool calls are handled\\n- Backend',
  );

  assert.equal(output, 'Tool calls are handled\n- Backend');
});

test('ModelJson decodes escaped quotes inside a streaming finish output', () => {
  const output = ModelJson.extractStreamingFinishOutput('{"action":"finish","output":"He said \\"hi\\" loudly"}');

  assert.equal(output, 'He said "hi" loudly');
});

test('ModelJson ignores a trailing incomplete escape in a streaming finish output', () => {
  const output = ModelJson.extractStreamingFinishOutput('{"action":"finish","output":"first line\\');

  assert.equal(output, 'first line');
});

test('ModelJson returns null for a streaming tool action (no finish output)', () => {
  const output = ModelJson.extractStreamingFinishOutput('{"action":"read","args":{"path":"a.ts"}}');

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
  const action = parseSummaryPlannerAction(
    JSON.stringify({
      action: 'read_lines',
      startLine: 10,
      endLine: 25,
    }),
  );

  assert.deepEqual(action, {
    action: 'tool',
    tool_name: 'read_lines',
    args: {
      startLine: 10,
      endLine: 25,
    },
  });
});

test('ModelJson omits explicit null placeholders from summary planner tool arguments', () => {
  const action = parseSummaryPlannerAction(
    JSON.stringify({
      action: 'find_text',
      query: 'needle',
      mode: 'literal',
      maxHits: null,
      contextLines: null,
    }),
  );
  assert.deepEqual(action, {
    action: 'tool',
    tool_name: 'find_text',
    args: { query: 'needle', mode: 'literal' },
  });
});

test('ModelJson preserves nested null data while omitting top-level null placeholders', () => {
  const action = parseSummaryPlannerAction(
    JSON.stringify({
      action: 'json_filter',
      collectionPath: null,
      filters: [{ path: 'deletedAt', op: 'eq', value: null }],
      select: null,
      limit: null,
    }),
  );
  assert.deepEqual(action, {
    action: 'tool',
    tool_name: 'json_filter',
    args: { filters: [{ path: 'deletedAt', op: 'eq', value: null }] },
  });
});

test('ModelJson rejects tool-argument repairs that synthesize missing values', () => {
  assert.equal(ModelJson.parseToolArguments('{"limit":}'), null);
});

test('ModelJson rejects planner repairs that synthesize missing values', () => {
  assert.throws(
    () => parseSummaryPlannerAction('{"action":"find_text","query":"needle","mode":"literal","maxHits":}'),
    /invalid planner payload/u,
  );
  assert.throws(
    () => parseSummaryPlannerAction('{"action":"find_text","query":"needle","mode":"literal","maxHits":/* null */}'),
    /invalid planner payload/u,
  );
});

test('ModelJson permits safe planner repair while omitting an explicit optional null', () => {
  const action = parseSummaryPlannerAction("{'action':'find_text','query':'needle','mode':'literal','maxHits':null,}");

  assert.deepEqual(action, {
    action: 'tool',
    tool_name: 'find_text',
    args: { query: 'needle', mode: 'literal' },
  });
});

test('ModelJson preserves top-level nulls that are not schema-declared omission fields', () => {
  const action = parseSummaryPlannerAction(
    JSON.stringify({
      action: 'json_filter',
      filters: null,
      undeclared: null,
    }),
  );

  assert.deepEqual(action, {
    action: 'tool',
    tool_name: 'json_filter',
    args: { filters: null, undeclared: null },
  });
});

test('ModelJson rejects wrapped summary planner tool actions', () => {
  assert.throws(
    () =>
      parseSummaryPlannerAction(
        JSON.stringify({
          action: 'tool',
          tool_name: 'read_lines',
          args: {
            startLine: 10,
            endLine: 25,
          },
        }),
      ),
    /unknown planner action/u,
  );
});

test('ModelJson parses direct repo-search planner tool actions', () => {
  const action = parseRepoSearchPlannerAction(
    JSON.stringify({
      action: 'grep',
      pattern: 'plan',
      glob: '*.ts',
    }),
    ['grep'],
  );

  assert.deepEqual(action, {
    action: 'tool',
    tool_name: 'grep',
    args: {
      pattern: 'plan',
      glob: '*.ts',
    },
  });
});

test('ModelJson omits explicit null placeholders from repo-search tool batches', () => {
  const action = parseRepoSearchPlannerAction(
    JSON.stringify({
      action: 'tool_batch',
      calls: [
        {
          action: 'grep',
          pattern: 'planner',
          path: null,
          glob: null,
          ignoreCase: null,
          literal: null,
          context: null,
          limit: null,
        },
        { action: 'ls', path: '.', limit: null },
      ],
    }),
    ['grep', 'ls'],
  );
  assert.deepEqual(action, {
    action: 'tool_batch',
    tool_calls: [
      { tool_name: 'grep', args: { pattern: 'planner' } },
      { tool_name: 'ls', args: { path: '.' } },
    ],
  });
});

test('ModelJson rejects null required repo-search arguments and empty batches', () => {
  assert.throws(
    () => parseRepoSearchPlannerAction(JSON.stringify({ action: 'grep', pattern: null }), ['grep']),
    /invalid planner tool action/u,
  );
  assert.throws(
    () => parseRepoSearchPlannerAction(JSON.stringify({ action: 'tool_batch', calls: [] }), ['grep']),
    /invalid planner tool batch action/u,
  );
});

test('ModelJson rejects a native repo tool call missing its required argument', () => {
  assert.throws(
    () => parseRepoSearchPlannerAction(JSON.stringify({ action: 'grep', glob: '*.ts' }), ['grep']),
    /invalid planner tool action/u,
  );
});

test('ModelJson rejects wrapped repo-search planner tool actions', () => {
  assert.throws(
    () =>
      parseRepoSearchPlannerAction(
        JSON.stringify({
          action: 'tool',
          tool_name: 'grep',
          args: {
            pattern: 'plan',
          },
        }),
        ['grep'],
      ),
    /unknown planner action/u,
  );
});

test('ModelJson rejects unknown repo-search tools after repair', () => {
  assert.throws(
    () => parseRepoSearchPlannerAction("{'action':'repo_delete_everything','command':'echo no'}", ['grep']),
    /unknown planner action/u,
  );
});

test('ModelJson rejects unrecoverable model JSON', () => {
  assert.throws(
    () => ModelJson.parseSummaryDecision('this is not json'),
    /Provider returned an invalid SiftKit decision payload/u,
  );
});

test('ModelJson parses valid repo-search tool action', () => {
  const action = parseRepoSearchPlannerAction('{"action":"git","command":"git status --short"}');
  assert.deepEqual(action, {
    action: 'tool',
    tool_name: 'git',
    args: { command: 'git status --short' },
  });
});

test('ModelJson rejects a git tool call whose command is not git', () => {
  assert.throws(
    () => parseRepoSearchPlannerAction('{"action":"git","command":"rm -rf ."}'),
    /invalid planner tool action/u,
  );
});

test('ModelJson parses valid repo-search finish action', () => {
  const action = parseRepoSearchPlannerAction('{"action":"finish","output":"done"}');
  assert.deepEqual(action, {
    action: 'finish',
    output: 'done',
  });
});

test('ModelJson rejects repo-search finish confidence', () => {
  assert.throws(
    () => parseRepoSearchPlannerAction('{"action":"finish","output":"done","confidence":0.7}'),
    /invalid planner finish action/u,
  );
});

test('ModelJson rejects invalid repo-search planner payloads', () => {
  assert.throws(() => parseRepoSearchPlannerAction('not-json'), /invalid planner payload/u);
  assert.throws(
    () => parseRepoSearchPlannerAction('{"action":"read_lines","command":"rg x"}'),
    /unknown planner action/u,
  );
  assert.throws(
    () => parseRepoSearchPlannerAction('{"action":"tool","tool_name":"run_repo_cmd","args":{"bad":"x"}}'),
    /unknown planner action/u,
  );
});

test('ModelJson repairs malformed escaped command payloads', () => {
  const malformed =
    '{"action":"grep","pattern":"rg -n \\"D:\\\\\\\\|C:\\\\\\\\|\\\\\\\\\\\\\\\\" src --type ts | Select-Object -First 30"';
  const action = parseRepoSearchPlannerAction(malformed);
  assert.deepEqual(action, {
    action: 'tool',
    tool_name: 'grep',
    args: {
      pattern: 'rg -n "D:\\\\|C:\\\\|\\\\\\\\" src --type ts | Select-Object -First 30',
    },
  });
});

import test from 'node:test';
import assert from 'node:assert/strict';

import { ModelJson, StreamingFinishOutputExtractor } from '../src/lib/model-json.js';
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

test('extractor decodes a complete streaming finish action', () => {
  const output = new StreamingFinishOutputExtractor().push('{"action":"finish","output":"Line one\\nLine two"}');
  assert.equal(output, 'Line one\nLine two');
});

test('extractor decodes the prefix while a finish output is still streaming', () => {
  const output = new StreamingFinishOutputExtractor().push(
    '{"action":"finish","output":"Tool calls are handled\\n- Backend',
  );
  assert.equal(output, 'Tool calls are handled\n- Backend');
});

test('extractor decodes escaped quotes inside a streaming finish output', () => {
  const output = new StreamingFinishOutputExtractor().push('{"action":"finish","output":"He said \\"hi\\" loudly"}');
  assert.equal(output, 'He said "hi" loudly');
});

test('extractor ignores a trailing incomplete escape', () => {
  const output = new StreamingFinishOutputExtractor().push('{"action":"finish","output":"first line\\');
  assert.equal(output, 'first line');
});

test('extractor returns null for a streaming tool action', () => {
  const output = new StreamingFinishOutputExtractor().push('{"action":"read","args":{"path":"a.ts"}}');
  assert.equal(output, null);
});

test('extractor permanently ignores later finish markers after a non-finish action', () => {
  const extractor = new StreamingFinishOutputExtractor();
  const readAction = '{"action":"read","args":{"path":"a.ts"}}';
  assert.equal(extractor.push(readAction), null);
  assert.equal(extractor.push(`${readAction}{"action":"finish","output":"wrong"}`), null);
});

test('extractor recognizes a top-level finish action after its output', () => {
  const extractor = new StreamingFinishOutputExtractor();
  const output = '{"output":"done"';
  assert.equal(extractor.push(output), null);
  assert.equal(extractor.push(`${output},"action":"finish"}`), 'done');
});

test('extractor ignores a nested non-finish action before a top-level finish action', () => {
  const extractor = new StreamingFinishOutputExtractor();
  const metadata = '{"metadata":{"action":"read"}';
  assert.equal(extractor.push(metadata), null);
  assert.equal(extractor.push(`${metadata},"action":"finish","output":"done"}`), 'done');
});

test('extractor ignores nested output fields in a finish action', () => {
  const output = new StreamingFinishOutputExtractor().push(
    '{"action":"finish","metadata":{"output":"wrong"},"output":"done"}',
  );
  assert.equal(output, 'done');
});

test('extractor returns null before the finish output key has streamed', () => {
  const output = new StreamingFinishOutputExtractor().push('{"action":"finish"');
  assert.equal(output, null);
});

test('extractor carries action and output markers with whitespace across pushes', () => {
  const extractor = new StreamingFinishOutputExtractor();
  const t1 = '{"act';
  const t2 = `${t1}ion" \n: "finish", "out`;
  const t3 = `${t2}put"\t: "done`;
  assert.equal(extractor.push(t1), null);
  assert.equal(extractor.push(t2), null);
  assert.equal(extractor.push(t3), 'done');
});

test('extractor decodes incrementally across pushes, resuming pending escapes', () => {
  const extractor = new StreamingFinishOutputExtractor();
  const t1 = '{"action":"finish","output":"ab';
  const t2 = `${t1}c\\`;
  const t3 = `${t2}n def`;
  assert.equal(extractor.push(t1), 'ab');
  assert.equal(extractor.push(t2), 'abc');
  assert.equal(extractor.push(t3), 'abc\n def');
});

test('extractor resumes a unicode escape split across pushes', () => {
  const extractor = new StreamingFinishOutputExtractor();
  const t1 = '{"action":"finish","output":"A\\u00';
  assert.equal(extractor.push(t1), 'A');
  assert.equal(extractor.push(`${t1}2F!`), 'A/!');
});

test('extractor freezes after a complete invalid unicode escape', () => {
  const extractor = new StreamingFinishOutputExtractor();
  const invalid = '{"action":"finish","output":"ok\\u0G00';
  assert.equal(extractor.push(invalid), 'ok');
  assert.equal(extractor.push(`${invalid} ignored`), 'ok');
});

test('extractor clears an invalid unicode stall when the text shrinks', () => {
  const extractor = new StreamingFinishOutputExtractor();
  assert.equal(extractor.push('{"action":"finish","output":"ok\\u0G00'), 'ok');
  assert.equal(extractor.push('{"action":"finish","output":"new'), 'new');
});

test('extractor freezes the value once the closing quote streams', () => {
  const extractor = new StreamingFinishOutputExtractor();
  const closed = '{"action":"finish","output":"done"}';
  assert.equal(extractor.push(closed), 'done');
  assert.equal(extractor.push(`${closed} trailing`), 'done');
});

test('extractor finds markers that only appear on a later push', () => {
  const extractor = new StreamingFinishOutputExtractor();
  assert.equal(extractor.push('{"action":"fin'), null);
  assert.equal(extractor.push('{"action":"finish","output":"hi'), 'hi');
});

test('extractor resets when the text shrinks', () => {
  const extractor = new StreamingFinishOutputExtractor();
  assert.equal(extractor.push('{"action":"finish","output":"done"}'), 'done');
  assert.equal(extractor.push('{"action":"finish","output":"d'), 'd');
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

test('ModelJson accepts typed run output modes and rejects invalid values', () => {
  assert.deepEqual(
    parseRepoSearchPlannerAction(
      '{"action":"run","command":"npm test","outputMode":"full"}',
      ['run'],
    ),
    {
      action: 'tool',
      tool_name: 'run',
      args: { command: 'npm test', outputMode: 'full' },
    },
  );

  assert.throws(
    () => parseRepoSearchPlannerAction(
      '{"action":"run","command":"npm test","outputMode":"verbose"}',
      ['run'],
    ),
    /invalid planner tool action/u,
  );
});

test('ModelJson passes the advertised run timeoutMs through to the engine', () => {
  assert.deepEqual(
    parseRepoSearchPlannerAction(
      '{"action":"run","command":"npm test","timeoutMs":300000}',
      ['run'],
    ),
    {
      action: 'tool',
      tool_name: 'run',
      args: { command: 'npm test', timeoutMs: 300000 },
    },
  );
});

test('ModelJson keeps the wrong run timeout key so the engine can reject it', () => {
  assert.deepEqual(
    parseRepoSearchPlannerAction(
      '{"action":"run","command":"npm test","timeout":300000}',
      ['run'],
    ),
    {
      action: 'tool',
      tool_name: 'run',
      args: { command: 'npm test', timeout: 300000 },
    },
  );
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

test('ModelJson prepends the git token to a git command that omits it', () => {
  assert.deepEqual(parseRepoSearchPlannerAction('{"action":"git","command":"status"}'), {
    action: 'tool',
    tool_name: 'git',
    args: { command: 'git status' },
  });
  assert.deepEqual(parseRepoSearchPlannerAction('{"action":"git","command":"rm -rf ."}'), {
    action: 'tool',
    tool_name: 'git',
    args: { command: 'git rm -rf .' },
  });
});

test('ModelJson rejects a git tool call with no command and names the missing field', () => {
  assert.throws(
    () => parseRepoSearchPlannerAction('{"action":"git","command":"   "}'),
    /invalid planner tool action: "git" requires a non-empty "command" string/u,
  );
});

test('ModelJson passes a non-empty required array through untouched', () => {
  assert.deepEqual(
    parseRepoSearchPlannerAction(
      JSON.stringify({ action: 'edit', path: 'a.ts', edits: [{ oldText: 'a', newText: 'b' }] }),
      ['edit'],
    ),
    {
      action: 'tool',
      tool_name: 'edit',
      args: { path: 'a.ts', edits: [{ oldText: 'a', newText: 'b' }] },
    },
  );
});

test('ModelJson reports a distinct reason for each tool-argument rejection path', () => {
  assert.throws(
    () => parseRepoSearchPlannerAction(JSON.stringify({ action: 'grep', glob: '*.ts' }), ['grep']),
    /"grep" requires "pattern" to be a non-empty string/u,
  );
  assert.throws(
    () => parseRepoSearchPlannerAction(JSON.stringify({ action: 'edit', path: 'a.ts', edits: [] }), ['edit']),
    /"edit" requires "edits" to be a non-empty array/u,
  );
  assert.throws(
    () => parseRepoSearchPlannerAction('{"action":"run","command":"npm test","outputMode":"verbose"}', ['run']),
    /"run" requires "outputMode" to be "auto" or "full"/u,
  );
});

// handleInvalidParse wraps the message in `Invalid action: ${message}. Return a valid …`, so a
// message carrying its own trailing period produces a double period in the transcript.
test('ModelJson thrown planner messages do not end in a period', () => {
  assert.throws(
    () => parseRepoSearchPlannerAction(JSON.stringify({ action: 'grep', glob: '*.ts' }), ['grep']),
    /"grep" requires "pattern" to be a non-empty string$/u,
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

test('ModelJson names the offending extra key on a finish action', () => {
  assert.throws(
    () => parseRepoSearchPlannerAction('{"action":"finish","output":"done","confidence":0.7}'),
    /invalid planner finish action: finish accepts only "action" and "output"; remove: confidence/u,
  );
});

test('ModelJson distinguishes an empty finish output from an extra finish key', () => {
  assert.throws(
    () => parseRepoSearchPlannerAction('{"action":"finish","output":"   "}'),
    /invalid planner finish action: "output" must be a non-empty string/u,
  );
});

test('ModelJson names the action and the valid alternatives for an unknown action', () => {
  assert.throws(
    () => parseRepoSearchPlannerAction('{"action":"read_lines","command":"rg x"}', ['ls', 'grep']),
    /unknown planner action "read_lines"; valid actions: finish, grep, ls, tool_batch/u,
  );
});

test('ModelJson explains an empty or malformed tool batch', () => {
  assert.throws(
    () => parseRepoSearchPlannerAction(JSON.stringify({ action: 'tool_batch', calls: [] }), ['grep']),
    /invalid planner tool batch action: "calls" must be a non-empty array/u,
  );
  assert.throws(
    () => parseRepoSearchPlannerAction(JSON.stringify({ action: 'tool_batch', calls: ['grep'] }), ['grep']),
    /invalid planner tool batch action: call 1 is not a JSON object/u,
  );
});

test('ModelJson names the offending call when a batch entry is unavailable or malformed', () => {
  assert.throws(
    () =>
      parseRepoSearchPlannerAction(
        JSON.stringify({ action: 'tool_batch', calls: [{ action: 'grep', pattern: 'x' }, { action: 'ls', path: '.' }] }),
        ['grep'],
      ),
    /invalid planner tool batch action: call 2 uses unavailable tool "ls"/u,
  );
  assert.throws(
    () =>
      parseRepoSearchPlannerAction(
        JSON.stringify({ action: 'tool_batch', calls: [{ action: 'grep', glob: '*.ts' }] }),
        ['grep'],
      ),
    /invalid planner tool batch action: call 1 — "grep" requires "pattern" to be a non-empty string/u,
  );
});

test('ModelJson restores Windows path separators eaten by JSON escapes in run commands', () => {
  // Regression: the model emitted `dashboard\tests\test\test.ts` inside a JSON string, so JSON.parse
  // consumed each `\t` as a TAB and PowerShell saw `dashboard<TAB>ests<TAB>est<TAB>est.ts`.
  const action = parseRepoSearchPlannerAction(
    String.raw`{"action":"run","command":"Select-String -Path dashboard\tests\test\test.ts, dashboard\test\test.tsx -Pattern 'readImageFiles' | Select-Object -Property Path, LineNumber, Line","timeoutMs":30000,"outputMode":"auto"}`,
    ['run'],
  );
  assert.deepEqual(action, {
    action: 'tool',
    tool_name: 'run',
    args: {
      command: String.raw`Select-String -Path dashboard\tests\test\test.ts, dashboard\test\test.tsx -Pattern 'readImageFiles' | Select-Object -Property Path, LineNumber, Line`,
      timeoutMs: 30000,
      outputMode: 'auto',
    },
  });
});

test('ModelJson restores Windows path separators eaten by JSON escapes in path arguments', () => {
  const action = parseRepoSearchPlannerAction('{"action":"read","path":"dashboard\\tests\\react-env.ts"}');
  assert.deepEqual(action, {
    action: 'tool',
    tool_name: 'read',
    args: { path: String.raw`dashboard\tests\react-env.ts` },
  });
});

test('ModelJson restores every control-character escape inside a path argument', () => {
  // \n, \r, \b and \f are as silently destructive as \t for `\node_modules`, `\reports`, `\bin`, `\fixtures`.
  const action = parseRepoSearchPlannerAction('{"action":"read","path":"a\\node_modules\\reports\\bin\\fixtures"}');
  assert.deepEqual(action, {
    action: 'tool',
    tool_name: 'read',
    args: { path: String.raw`a\node_modules\reports\bin\fixtures` },
  });
});

test('ModelJson keeps deliberate newlines in run commands', () => {
  const action = parseRepoSearchPlannerAction(
    JSON.stringify({ action: 'run', command: 'Get-Content a.txt\nSelect-String foo' }),
    ['run'],
  );
  assert.deepEqual(action, {
    action: 'tool',
    tool_name: 'run',
    args: { command: 'Get-Content a.txt\nSelect-String foo' },
  });
});

test('ModelJson never rewrites write content or edit payloads', () => {
  const content = 'line1\n\tindented\nline3';
  const writeAction = parseRepoSearchPlannerAction(JSON.stringify({ action: 'write', path: 'a.ts', content }), [
    'write',
  ]);
  assert.deepEqual(writeAction, {
    action: 'tool',
    tool_name: 'write',
    args: { path: 'a.ts', content },
  });

  const edits = [{ oldText: 'const a = 1;\n\tconst b = 2;', newText: 'const a = 3;\n\tconst b = 4;' }];
  const editAction = parseRepoSearchPlannerAction(JSON.stringify({ action: 'edit', path: 'a.ts', edits }), ['edit']);
  assert.deepEqual(editAction, {
    action: 'tool',
    tool_name: 'edit',
    args: { path: 'a.ts', edits },
  });
});

test('ModelJson restores Windows path separators eaten by JSON escapes in git commands', () => {
  const action = parseRepoSearchPlannerAction('{"action":"git","command":"log --oneline -- dashboard\\tests"}');
  assert.deepEqual(action, {
    action: 'tool',
    tool_name: 'git',
    args: { command: String.raw`git log --oneline -- dashboard\tests` },
  });
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

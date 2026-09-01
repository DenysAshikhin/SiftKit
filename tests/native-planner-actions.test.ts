import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AgentLoopFinishAction } from '../src/agent-loop/types.js';
import { JsonObjectSchema, type JsonObject } from '../src/lib/json-types.js';
import type { LlamaCppToolCall } from '../src/llm-protocol/types.js';
import { completeLiveContent } from '../src/llm-protocol/live-content-classifier.js';
import { z } from '../src/lib/zod.js';
import { buildPlannerJsonSchema, type PlannerToolDefinition } from '../src/planner-protocol/json-schema.js';
import {
  NativePlannerResponseError,
  NativePlannerToolCallError,
  parseNativePlannerActions as parseNativePlannerActionsFromResult,
  type NativePlannerActionOptions,
} from '../src/planner-protocol/native-actions.js';

function parseNativePlannerActions(
  response: { text: string; toolCalls: LlamaCppToolCall[] },
  options: NativePlannerActionOptions,
) {
  return parseNativePlannerActionsFromResult({
    ...completeLiveContent(response.text, response.toolCalls.length > 0),
    toolCalls: response.toolCalls,
  }, options);
}

const GitStatusArgumentsSchema = z.strictObject({
  operation: z.literal('status'),
}).transform((value) => JsonObjectSchema.parse(value));

const FinishArgumentsSchema = z.strictObject({
  classification: z.enum(['summary', 'command_failure', 'unsupported_input']),
  raw_review_required: z.boolean(),
  output: z.string().trim().min(1),
  review_note: z.string().trim().min(1).optional(),
}).transform((value): AgentLoopFinishAction => ({
  kind: 'finish',
  text: value.output,
  classification: value.classification,
  rawReviewRequired: value.raw_review_required,
  rawAction: JsonObjectSchema.parse(value),
}));

function definition(
  name: string,
  argumentSchema: z.ZodType<JsonObject>,
  exampleArgs: JsonObject,
): PlannerToolDefinition {
  return {
    kind: 'tool',
    type: 'function',
    argumentSchema,
    exampleArgs,
    function: {
      name,
      description: `${name} test tool`,
      parameters: buildPlannerJsonSchema(argumentSchema),
    },
  };
}

function finishDefinition(
  name: string,
  argumentSchema: z.ZodType<AgentLoopFinishAction>,
  exampleArgs: JsonObject,
): PlannerToolDefinition {
  return {
    kind: 'finish',
    type: 'function',
    argumentSchema,
    exampleArgs,
    function: {
      name,
      description: `${name} test tool`,
      parameters: buildPlannerJsonSchema(argumentSchema),
    },
  };
}

const EditArgumentsSchema = z.strictObject({
  path: z.string().min(1),
  edits: z.array(z.strictObject({
    oldText: z.string().min(1),
    newText: z.string(),
  })).min(1),
}).transform((value) => JsonObjectSchema.parse(value));

const toolDefinitions = [
  definition('git', GitStatusArgumentsSchema, { operation: 'status' }),
  definition('edit', EditArgumentsSchema, {
    path: 'README.md',
    edits: [{ oldText: 'a', newText: 'b' }],
  }),
];
const summaryToolDefinitions = [
  ...toolDefinitions,
  finishDefinition('finish', FinishArgumentsSchema, {
    classification: 'summary',
    raw_review_required: false,
    output: 'done',
  }),
];

function call(id: string, name: string, args: JsonObject): LlamaCppToolCall {
  return {
    id,
    type: 'function',
    function: { name, arguments: JSON.stringify(args) },
  };
}

test('content without tool calls is a repo-search finish', () => {
  assert.deepEqual(
    parseNativePlannerActions(
      { text: 'final answer', toolCalls: [] },
      { toolDefinitions, contentWithoutTools: 'finish' },
    ),
    [{ kind: 'finish', text: 'final answer' }],
  );
});

test('content with tool calls maps only the native batch', () => {
  assert.deepEqual(
    parseNativePlannerActions(
      {
        text: 'Checking both facts.',
        toolCalls: [
          call('provider-1', 'git', { operation: 'status' }),
          call('provider-2', 'git', { operation: 'status' }),
        ],
      },
      { toolDefinitions, contentWithoutTools: 'finish' },
    ),
    [
      { kind: 'tool', callId: 'provider-1', toolName: 'git', args: { operation: 'status' } },
      { kind: 'tool', callId: 'provider-2', toolName: 'git', args: { operation: 'status' } },
    ],
  );
});

test('empty responses are invalid', () => {
  assert.throws(
    () => parseNativePlannerActions(
      { text: '  ', toolCalls: [] },
      { toolDefinitions, contentWithoutTools: 'finish' },
    ),
    NativePlannerResponseError,
  );
});

test('a response whose narration is empty after classification is invalid, not an empty finish', () => {
  // '<tool_call' is an unterminated open-tag prefix: the classifier reports 'undecided' with
  // empty narration while rawText is non-empty, which used to become a finish with text ''.
  assert.throws(
    () => parseNativePlannerActions(
      { text: '<tool_call', toolCalls: [] },
      { toolDefinitions, contentWithoutTools: 'finish' },
    ),
    (error) => error instanceof NativePlannerResponseError && /no answer content/u.test(error.message),
  );
});

test('unknown tools fail on their provider call id', () => {
  assert.throws(
    () => parseNativePlannerActions(
      { text: '', toolCalls: [call('unknown-1', 'shell', { command: 'dir' })] },
      { toolDefinitions, contentWithoutTools: 'finish' },
    ),
    (error) => error instanceof NativePlannerToolCallError
      && error.callId === 'unknown-1'
      && error.toolName === 'shell'
      && /Allowed tools: git/u.test(error.message),
  );
});

test('invalid arguments fail on their provider call id and field', () => {
  assert.throws(
    () => parseNativePlannerActions(
      { text: '', toolCalls: [call('invalid-1', 'git', { operation: 'log' })] },
      { toolDefinitions, contentWithoutTools: 'finish' },
    ),
    (error) => error instanceof NativePlannerToolCallError
      && error.callId === 'invalid-1'
      && error.toolName === 'git'
      && /operation/u.test(error.message),
  );
});

test('Qwen dialect text falls back to native tool calls', () => {
  assert.deepEqual(
    parseNativePlannerActions(
      {
        text: '<tool_call><function=git><parameter=operation>status</parameter></function></tool_call>',
        toolCalls: [],
      },
      { toolDefinitions, contentWithoutTools: 'finish' },
    ),
    [{ kind: 'tool', callId: 'call_git_0', toolName: 'git', args: { operation: 'status' } }],
  );
});

test('unknown Qwen dialect tools reach native validation with their parsed call id', () => {
  assert.throws(
    () => parseNativePlannerActions(
      {
        text: '<tool_call><function=shell><parameter=command>dir</parameter></function></tool_call>',
        toolCalls: [],
      },
      { toolDefinitions, contentWithoutTools: 'finish' },
    ),
    (error) => error instanceof NativePlannerToolCallError
      && error.callId === 'call_shell_0'
      && error.toolName === 'shell',
  );
});

test('summary finish tool preserves every field accepted by its authoritative schema', () => {
  assert.deepEqual(
    parseNativePlannerActions(
      {
        text: '',
        toolCalls: [call('finish-1', 'finish', {
          classification: 'command_failure',
          raw_review_required: true,
          output: 'build failed',
          review_note: 'captured by the authoritative schema',
        })],
      },
      {
        toolDefinitions: summaryToolDefinitions,
        contentWithoutTools: 'invalid',
      },
    ),
    [{
      kind: 'finish',
      text: 'build failed',
      classification: 'command_failure',
      rawReviewRequired: true,
      rawAction: {
        classification: 'command_failure',
        raw_review_required: true,
        output: 'build failed',
        review_note: 'captured by the authoritative schema',
      },
    }],
  );
});

test('summary content without a finish tool is invalid', () => {
  assert.throws(
    () => parseNativePlannerActions(
      { text: 'unstructured answer', toolCalls: [] },
      {
        toolDefinitions: summaryToolDefinitions,
        contentWithoutTools: 'invalid',
      },
    ),
    NativePlannerResponseError,
  );
});

test('finish content quoting the tool-call opener in inline code finishes', () => {
  const text = 'Fallback parses `<tool_call>` markup from text.';
  assert.deepEqual(
    parseNativePlannerActions(
      { text, toolCalls: [] },
      { toolDefinitions, contentWithoutTools: 'finish' },
    ),
    [{ kind: 'finish', text }],
  );
});

test('finish content quoting partial markup in a fenced block finishes', () => {
  const text = 'The textual dialect looks like:\n```\n<tool_call><function=read>\n```\nand is parsed as a fallback.';
  assert.deepEqual(
    parseNativePlannerActions(
      { text, toolCalls: [] },
      { toolDefinitions, contentWithoutTools: 'finish' },
    ),
    [{ kind: 'finish', text }],
  );
});

test('finish content mentioning function and parameter tags without the opener finishes', () => {
  const text = 'Markup uses <function=name> and <parameter=key> tags inside the call block.';
  assert.deepEqual(
    parseNativePlannerActions(
      { text, toolCalls: [] },
      { toolDefinitions, contentWithoutTools: 'finish' },
    ),
    [{ kind: 'finish', text }],
  );
});

test('bare unclosed tool-call opener is rejected as malformed markup with finish guidance', () => {
  assert.throws(
    () => parseNativePlannerActions(
      { text: 'Let me call <tool_call><function=git>', toolCalls: [] },
      { toolDefinitions, contentWithoutTools: 'finish' },
    ),
    (error) => error instanceof NativePlannerResponseError
      && /malformed tool-call markup/u.test(error.message)
      && /finish by returning/u.test(error.message),
  );
});

test('bare tool-call block without a function tag is rejected as malformed markup', () => {
  assert.throws(
    () => parseNativePlannerActions(
      { text: '<tool_call>not a function</tool_call>', toolCalls: [] },
      { toolDefinitions, contentWithoutTools: 'finish' },
    ),
    (error) => error instanceof NativePlannerResponseError
      && /malformed tool-call markup/u.test(error.message)
      && /finish by returning/u.test(error.message),
  );
});

test('summary content quoting the opener in inline code keeps the content-without-tools message', () => {
  assert.throws(
    () => parseNativePlannerActions(
      { text: 'The fallback scans for `<tool_call>` markers.', toolCalls: [] },
      { toolDefinitions: summaryToolDefinitions, contentWithoutTools: 'invalid' },
    ),
    (error) => error instanceof NativePlannerResponseError
      && /content without a valid tool call/u.test(error.message),
  );
});

test('summary bare malformed markup is rejected without finish guidance', () => {
  assert.throws(
    () => parseNativePlannerActions(
      { text: '<tool_call>not a function</tool_call>', toolCalls: [] },
      { toolDefinitions: summaryToolDefinitions, contentWithoutTools: 'invalid' },
    ),
    (error) => error instanceof NativePlannerResponseError
      && /malformed tool-call markup/u.test(error.message)
      && !/finish by returning/u.test(error.message),
  );
});

test('JSON-stringified array argument is repaired to a real array', () => {
  const edits = [
    { oldText: 'Verified: 161/161 unit tests', newText: 'Verified: 167/167 unit tests' },
    { oldText: 'TabbyAPI: 161/161 tests', newText: 'TabbyAPI: 167/167 tests' },
  ];
  assert.deepEqual(
    parseNativePlannerActions(
      {
        text: '',
        toolCalls: [call('edit-1', 'edit', { path: 'docs/handoff.md', edits: JSON.stringify(edits) })],
      },
      { toolDefinitions, contentWithoutTools: 'finish' },
    ),
    [{ kind: 'tool', callId: 'edit-1', toolName: 'edit', args: { path: 'docs/handoff.md', edits } }],
  );
});

test('JSON-stringified object argument is repaired to a real object', () => {
  const inner = { oldText: 'a', newText: 'b' };
  assert.deepEqual(
    parseNativePlannerActions(
      {
        text: '',
        toolCalls: [call('edit-2', 'edit', { path: 'README.md', edits: [JSON.stringify(inner)] })],
      },
      { toolDefinitions, contentWithoutTools: 'finish' },
    ),
    [{ kind: 'tool', callId: 'edit-2', toolName: 'edit', args: { path: 'README.md', edits: [inner] } }],
  );
});

test('non-JSON string where an array is expected still fails on the field', () => {
  assert.throws(
    () => parseNativePlannerActions(
      {
        text: '',
        toolCalls: [call('edit-3', 'edit', { path: 'README.md', edits: 'replace 161 with 167' })],
      },
      { toolDefinitions, contentWithoutTools: 'finish' },
    ),
    (error) => error instanceof NativePlannerToolCallError
      && error.callId === 'edit-3'
      && /edits/u.test(error.message),
  );
});

test('JSON-looking text in a string-typed argument is left untouched', () => {
  assert.deepEqual(
    parseNativePlannerActions(
      {
        text: '',
        toolCalls: [call('edit-4', 'edit', {
          path: '[not-json].md',
          edits: [{ oldText: '["x"]', newText: '{"y":1}' }],
        })],
      },
      { toolDefinitions, contentWithoutTools: 'finish' },
    ),
    [{
      kind: 'tool',
      callId: 'edit-4',
      toolName: 'edit',
      args: { path: '[not-json].md', edits: [{ oldText: '["x"]', newText: '{"y":1}' }] },
    }],
  );
});

test('finish content quoting a complete tool-call example in a fenced block finishes', () => {
  const text = [
    'A full example of the textual dialect:',
    '```',
    '<tool_call><function=git><parameter=operation>status</parameter></function></tool_call>',
    '```',
    'It is parsed as a fallback.',
  ].join('\n');
  assert.deepEqual(
    parseNativePlannerActions(
      { text, toolCalls: [] },
      { toolDefinitions, contentWithoutTools: 'finish' },
    ),
    [{ kind: 'finish', text }],
  );
});

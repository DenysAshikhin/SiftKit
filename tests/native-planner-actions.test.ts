import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AgentLoopFinishAction } from '../src/agent-loop/types.js';
import { JsonObjectSchema, type JsonObject } from '../src/lib/json-types.js';
import type { LlamaCppToolCall } from '../src/llm-protocol/types.js';
import { z } from '../src/lib/zod.js';
import { buildPlannerJsonSchema, type PlannerToolDefinition } from '../src/planner-protocol/json-schema.js';
import {
  NativePlannerResponseError,
  NativePlannerToolCallError,
  parseNativePlannerActions,
} from '../src/planner-protocol/native-actions.js';

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

const toolDefinitions = [
  definition('git', GitStatusArgumentsSchema, { operation: 'status' }),
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

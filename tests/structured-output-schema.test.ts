import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildFinishValidationJsonSchema,
  buildLlamaJsonSchemaResponseFormat,
  buildRepoSearchPlannerActionJsonSchema,
  buildSummaryDecisionJsonSchema,
  buildSummaryPlannerActionJsonSchema,
  type StructuredOutputToolDefinition,
} from '../src/providers/structured-output-schema.js';
import {
  isJsonObject,
  type JsonObject,
  type JsonValue,
  type OptionalJsonValue,
} from '../src/lib/json-types.js';

const SUMMARY_TOOLS: StructuredOutputToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'find_text',
      description: 'find text',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          mode: { type: 'string' },
        },
        required: ['query', 'mode'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_lines',
      description: 'read lines',
      parameters: {
        type: 'object',
        properties: {
          startLine: { type: 'integer' },
          endLine: { type: 'integer' },
        },
        required: ['startLine', 'endLine'],
      },
    },
  },
];

function requireObject(value: OptionalJsonValue): JsonObject {
  if (!isJsonObject(value)) {
    throw new Error('Expected a JSON object in planner schema test.');
  }
  return value;
}

function requireArray(value: OptionalJsonValue): JsonValue[] {
  if (!Array.isArray(value)) {
    throw new Error('Expected a JSON array in planner schema test.');
  }
  return value;
}

function getActionVariant(schema: JsonObject, action: string): JsonObject {
  for (const candidate of requireArray(schema.anyOf)) {
    const variant = requireObject(candidate);
    const actionSchema = requireObject(requireObject(variant.properties).action);
    if (actionSchema.const === action) {
      return variant;
    }
  }
  throw new Error(`Missing planner action variant: ${action}`);
}

test('buildSummaryDecisionJsonSchema excludes unsupported_input when disabled', () => {
  const schema = buildSummaryDecisionJsonSchema({ allowUnsupportedInput: false });
  const schemaText = JSON.stringify(schema);
  assert.match(schemaText, /classification/u);
  assert.match(schemaText, /command_failure/u);
  assert.doesNotMatch(schemaText, /unsupported_input/u);
  assert.match(schemaText, /raw_review_required/u);
  assert.match(schemaText, /"additionalProperties":false/u);
});

test('buildSummaryPlannerActionJsonSchema encodes only provided tools', () => {
  const schema = buildSummaryPlannerActionJsonSchema({
    toolDefinitions: SUMMARY_TOOLS,
    allowUnsupportedInput: true,
  });
  const schemaText = JSON.stringify(schema);
  assert.match(schemaText, /find_text/u);
  assert.match(schemaText, /read_lines/u);
  assert.doesNotMatch(schemaText, /json_filter/u);
  assert.match(schemaText, /tool_batch/u);
  assert.match(schemaText, /calls/u);
  assert.match(schemaText, /finish/u);
  assert.doesNotMatch(schemaText, /tool_name/u);
  assert.doesNotMatch(schemaText, /args/u);
});

test('buildRepoSearchPlannerActionJsonSchema enforces command args and output-only finish', () => {
  const schema = buildRepoSearchPlannerActionJsonSchema({
    toolDefinitions: [{
      type: 'function',
      function: {
        name: 'run_repo_cmd',
        description: 'repo command',
        parameters: {
          type: 'object',
          properties: { command: { type: 'string' } },
          required: ['command'],
        },
      },
    }],
  });
  const schemaText = JSON.stringify(schema);
  assert.match(schemaText, /run_repo_cmd/u);
  assert.match(schemaText, /command/u);
  assert.doesNotMatch(schemaText, /confidence/u);
  assert.doesNotMatch(schemaText, /tool_name/u);
  assert.doesNotMatch(schemaText, /args/u);
  assert.match(schemaText, /"additionalProperties":false/u);
});

test('planner schemas never emit oneOf at any depth', () => {
  // kbnf (via formatron, via exllamav3) mis-handles `oneOf`: it masks logits to an allowed token
  // set, samples from that set, then rejects the same token when asked to accept it. That single
  // rejection permanently wedges the TabbyAPI inference server. See
  // docs/handoff-oneof-grammar-wedge.md. Every variant is discriminated by a `const` action name
  // and carries additionalProperties:false, so anyOf is equivalent here, not a loosening.
  const schemas = [
    buildRepoSearchPlannerActionJsonSchema({ toolDefinitions: SUMMARY_TOOLS }),
    buildRepoSearchPlannerActionJsonSchema({ toolDefinitions: [] }),
    buildSummaryPlannerActionJsonSchema({ toolDefinitions: SUMMARY_TOOLS, allowUnsupportedInput: true }),
    buildSummaryPlannerActionJsonSchema({ toolDefinitions: [], allowUnsupportedInput: false }),
  ];
  for (const schema of schemas) {
    assert.doesNotMatch(JSON.stringify(schema), /"oneOf"/u);
  }
});

test('planner tool schemas require every key and make only original optional keys nullable', () => {
  const tool: StructuredOutputToolDefinition = {
    type: 'function',
    function: {
      name: 'inspect',
      parameters: {
        type: 'object',
        properties: {
          requiredText: { type: 'string' },
          optionalEnum: { type: 'string', enum: ['a', 'b'] },
          optionalAny: {},
          optionalObject: {
            type: 'object',
            properties: {
              requiredNested: { type: 'string' },
              optionalNested: { type: 'integer' },
            },
            required: ['requiredNested'],
          },
          optionalArray: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                requiredItem: { type: 'boolean' },
                optionalItem: { type: 'number' },
              },
              required: ['requiredItem'],
            },
          },
        },
        required: ['requiredText'],
      },
    },
  };
  const schema = buildRepoSearchPlannerActionJsonSchema({ toolDefinitions: [tool] });
  const direct = getActionVariant(schema, 'inspect');
  const batch = getActionVariant(schema, 'tool_batch');
  const calls = requireObject(requireObject(batch.properties).calls);

  assert.deepEqual(direct, {
    type: 'object',
    properties: {
      action: { const: 'inspect' },
      requiredText: { type: 'string' },
      optionalEnum: { anyOf: [{ type: 'string', enum: ['a', 'b'] }, { type: 'null' }] },
      optionalAny: { anyOf: [{}, { type: 'null' }] },
      optionalObject: {
        anyOf: [{
          type: 'object',
          properties: {
            requiredNested: { type: 'string' },
            optionalNested: { anyOf: [{ type: 'integer' }, { type: 'null' }] },
          },
          required: ['requiredNested', 'optionalNested'],
        }, { type: 'null' }],
      },
      optionalArray: {
        anyOf: [{
          type: 'array',
          items: {
            type: 'object',
            properties: {
              requiredItem: { type: 'boolean' },
              optionalItem: { anyOf: [{ type: 'number' }, { type: 'null' }] },
            },
            required: ['requiredItem', 'optionalItem'],
          },
        }, { type: 'null' }],
      },
    },
    required: ['action', 'requiredText', 'optionalEnum', 'optionalAny', 'optionalObject', 'optionalArray'],
    additionalProperties: false,
  });
  assert.equal(Object.hasOwn(calls, 'minItems'), false);
  assert.deepEqual(calls.items, direct);
});

test('multi-tool planner schema unions action variants and tool_batch items with anyOf', () => {
  const schema = buildRepoSearchPlannerActionJsonSchema({ toolDefinitions: SUMMARY_TOOLS });
  const batch = getActionVariant(schema, 'tool_batch');
  const calls = requireObject(requireObject(batch.properties).calls);
  assert.equal(requireArray(schema.anyOf).length, 4);
  assert.equal(requireArray(requireObject(calls.items).anyOf).length, 2);
});

test('buildFinishValidationJsonSchema enforces verdict and reason', () => {
  const schema = buildFinishValidationJsonSchema();
  const schemaText = JSON.stringify(schema);
  assert.match(schemaText, /verdict/u);
  assert.match(schemaText, /pass/u);
  assert.match(schemaText, /fail/u);
  assert.match(schemaText, /reason/u);
});

test('buildLlamaJsonSchemaResponseFormat wraps schema for chat completions', () => {
  const schema = buildFinishValidationJsonSchema();
  const responseFormat = buildLlamaJsonSchemaResponseFormat({
    name: 'finish_validation',
    schema,
  });
  assert.deepEqual(responseFormat.type, 'json_schema');
  assert.deepEqual(responseFormat.json_schema.name, 'finish_validation');
  assert.deepEqual(responseFormat.json_schema.strict, true);
  assert.deepEqual(responseFormat.json_schema.schema, schema);
});

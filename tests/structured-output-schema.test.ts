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
  assert.match(schemaText, /finish/u);
});

test('buildRepoSearchPlannerActionJsonSchema enforces command args and finish confidence', () => {
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
  assert.match(schemaText, /confidence/u);
  assert.match(schemaText, /"additionalProperties":false/u);
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

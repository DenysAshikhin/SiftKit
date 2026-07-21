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

test('multi-tool planner schema unions variants with anyOf, including inside tool_batch', () => {
  const schema = buildRepoSearchPlannerActionJsonSchema({ toolDefinitions: SUMMARY_TOOLS });
  const schemaText = JSON.stringify(schema);
  // top-level union plus the tool_batch calls[] item union
  assert.equal(schemaText.match(/"anyOf"/gu)?.length, 2);
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

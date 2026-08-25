import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildFinishValidationJsonSchema,
  buildLlamaJsonSchemaResponseFormat,
  buildSummaryDecisionJsonSchema,
} from '../src/providers/structured-output-schema.js';

test('buildSummaryDecisionJsonSchema excludes unsupported_input when disabled', () => {
  const schema = buildSummaryDecisionJsonSchema({ allowUnsupportedInput: false });
  const schemaText = JSON.stringify(schema);
  assert.match(schemaText, /classification/u);
  assert.match(schemaText, /command_failure/u);
  assert.doesNotMatch(schemaText, /unsupported_input/u);
  assert.match(schemaText, /raw_review_required/u);
  assert.match(schemaText, /"additionalProperties":false/u);
});

test('buildSummaryDecisionJsonSchema includes unsupported_input when enabled', () => {
  assert.match(
    JSON.stringify(buildSummaryDecisionJsonSchema({ allowUnsupportedInput: true })),
    /unsupported_input/u,
  );
});

test('buildFinishValidationJsonSchema enforces verdict and reason', () => {
  const schemaText = JSON.stringify(buildFinishValidationJsonSchema());
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
  assert.equal(responseFormat.type, 'json_schema');
  assert.equal(responseFormat.json_schema.name, 'finish_validation');
  assert.equal(responseFormat.json_schema.strict, true);
  assert.deepEqual(responseFormat.json_schema.schema, schema);
});

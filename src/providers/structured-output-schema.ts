import type { JsonObject } from '../lib/json-types.js';

type JsonSchema = JsonObject;

type JsonSchemaObject = {
  type: 'object';
  properties: JsonObject;
  required: string[];
  additionalProperties: false;
};

export function buildSummaryDecisionJsonSchema(options: { allowUnsupportedInput: boolean }): JsonSchemaObject {
  const classificationEnum = options.allowUnsupportedInput
    ? ['summary', 'command_failure', 'unsupported_input']
    : ['summary', 'command_failure'];
  return {
    type: 'object',
    properties: {
      classification: { type: 'string', enum: classificationEnum },
      raw_review_required: { type: 'boolean' },
      output: { type: 'string' },
    },
    required: ['classification', 'raw_review_required', 'output'],
    additionalProperties: false,
  };
}

export function buildLlamaJsonSchemaResponseFormat(options: { name: string; schema: JsonSchema }): {
  type: 'json_schema';
  json_schema: { name: string; strict: boolean; schema: JsonSchema };
} {
  return {
    type: 'json_schema',
    json_schema: {
      name: options.name,
      strict: true,
      schema: options.schema,
    },
  };
}

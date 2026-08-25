import type { JsonObject } from '../lib/json-types.js';
import { buildRepoSearchPlannerProtocol } from '../planner-protocol/repo-search.js';
import { buildSummaryPlannerProtocol } from '../planner-protocol/summary.js';
import type { PlannerToolDefinition } from '../planner-protocol/json-schema.js';

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

export function buildSummaryPlannerActionJsonSchema(options: {
  toolDefinitions: readonly PlannerToolDefinition[];
  allowUnsupportedInput: boolean;
}): JsonSchema {
  const protocol = buildSummaryPlannerProtocol(
    options.toolDefinitions,
    options.allowUnsupportedInput,
  );
  return protocol.jsonSchema;
}

export function buildRepoSearchPlannerActionJsonSchema(options: {
  toolDefinitions: readonly PlannerToolDefinition[];
}): JsonSchema {
  const protocol = buildRepoSearchPlannerProtocol(options.toolDefinitions);
  return protocol.jsonSchema;
}

export function buildFinishValidationJsonSchema(): JsonSchemaObject {
  return {
    type: 'object',
    properties: {
      verdict: {
        type: 'string',
        enum: ['pass', 'fail'],
      },
      reason: { type: 'string' },
    },
    required: ['verdict', 'reason'],
    additionalProperties: false,
  };
}

export function buildApprovalVerdictJsonSchema(): JsonSchemaObject {
  return {
    type: 'object',
    properties: {
      verdict: { type: 'string', enum: ['approve', 'deny', 'unsure'] },
      reason: { type: 'string' },
    },
    required: ['verdict', 'reason'],
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

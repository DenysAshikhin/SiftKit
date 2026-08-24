import { JsonObjectSchema, type JsonObject, type OptionalJsonValue } from '../lib/json-types.js';
import type { LlamaCppToolParameterSchema } from '../llm-protocol/types.js';

export type StructuredOutputToolDefinition = {
  type: 'function';
  function: {
    name: string;
    description?: string;
    parameters?: LlamaCppToolParameterSchema;
  };
};

type JsonSchema = JsonObject;

type JsonSchemaObject = {
  type: 'object';
  properties: JsonObject;
  required: string[];
  additionalProperties: false;
};

// A tool-parameter fragment carries a `[key: string]: unknown` index, so it is
// not directly a JsonObject; validate it into one at this build boundary.
function getObjectRecord(value: LlamaCppToolParameterSchema | OptionalJsonValue): JsonObject {
  return value && typeof value === 'object' && !Array.isArray(value) ? JsonObjectSchema.parse(value) : {};
}

function getRequiredList(value: OptionalJsonValue): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0);
}

// `anyOf`, never `oneOf`: the kbnf grammar engine behind TabbyAPI mis-handles `oneOf` and
// permanently wedges the inference server on the first constrained turn. See
// docs/handoff-oneof-grammar-wedge.md. Variants are discriminated by a `const` action name and
// carry additionalProperties:false, so they are mutually exclusive by construction and anyOf
// validates identically.
function buildAnyOf(values: JsonSchema[]): JsonSchema {
  if (values.length === 1) {
    return values[0];
  }
  return { anyOf: values };
}

function buildPlannerToolCallSchema(toolName: string, parameters: JsonObject): JsonSchemaObject {
  return {
    type: 'object',
    properties: {
      action: { const: toolName },
      ...getObjectRecord(parameters.properties),
    },
    required: ['action', ...getRequiredList(parameters.required)],
    additionalProperties: false,
  };
}

function buildPlannerToolCallSchemas(tool: StructuredOutputToolDefinition): JsonSchemaObject[] {
  const parameters = getObjectRecord(tool.function.parameters);
  const variants = Array.isArray(parameters.anyOf)
    ? parameters.anyOf.map(getObjectRecord).filter((variant) => Object.keys(variant).length > 0)
    : [];
  return (variants.length > 0 ? variants : [parameters])
    .map((variant) => buildPlannerToolCallSchema(tool.function.name, variant));
}

function buildPlannerToolBatchActionSchema(toolDefinitions: StructuredOutputToolDefinition[]): JsonSchemaObject {
  return {
    type: 'object',
    properties: {
      action: { const: 'tool_batch' },
      calls: {
        type: 'array',
        minItems: 1,
        items: buildAnyOf(toolDefinitions.flatMap(buildPlannerToolCallSchemas)),
      },
    },
    required: ['action', 'calls'],
    additionalProperties: false,
  };
}

function buildSummaryPlannerFinishActionSchema(options: { allowUnsupportedInput: boolean }): JsonSchemaObject {
  const classificationEnum = options.allowUnsupportedInput
    ? ['summary', 'command_failure', 'unsupported_input']
    : ['summary', 'command_failure'];
  return {
    type: 'object',
    properties: {
      action: { const: 'finish' },
      classification: { type: 'string', enum: classificationEnum },
      raw_review_required: { type: 'boolean' },
      output: { type: 'string' },
    },
    required: ['action', 'classification', 'raw_review_required', 'output'],
    additionalProperties: false,
  };
}

function buildRepoSearchPlannerFinishActionSchema(): JsonSchemaObject {
  return {
    type: 'object',
    properties: {
      action: { const: 'finish' },
      output: { type: 'string' },
    },
    required: ['action', 'output'],
    additionalProperties: false,
  };
}

function buildPlannerActionSchema(options: {
  toolDefinitions: StructuredOutputToolDefinition[];
  finishActionSchema: JsonSchemaObject;
}): JsonSchema {
  const actionSchemas: JsonSchema[] = [options.finishActionSchema];
  if (options.toolDefinitions.length > 0) {
    actionSchemas.unshift(
      ...options.toolDefinitions.flatMap(buildPlannerToolCallSchemas),
      buildPlannerToolBatchActionSchema(options.toolDefinitions),
    );
  }
  return buildAnyOf(actionSchemas);
}

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
  toolDefinitions: StructuredOutputToolDefinition[];
  allowUnsupportedInput: boolean;
}): JsonSchema {
  return buildPlannerActionSchema({
    toolDefinitions: options.toolDefinitions,
    finishActionSchema: buildSummaryPlannerFinishActionSchema({
      allowUnsupportedInput: options.allowUnsupportedInput,
    }),
  });
}

export function buildRepoSearchPlannerActionJsonSchema(options: {
  toolDefinitions: StructuredOutputToolDefinition[];
}): JsonSchema {
  return buildPlannerActionSchema({
    toolDefinitions: options.toolDefinitions,
    finishActionSchema: buildRepoSearchPlannerFinishActionSchema(),
  });
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

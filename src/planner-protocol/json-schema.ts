import { JsonObjectSchema, type JsonObject, type OptionalJsonValue } from '../lib/json-types.js';
import type { LlamaCppToolParameterSchema } from '../llm-protocol/types.js';

export type PlannerToolDefinition = {
  type: 'function';
  function: {
    name: string;
    description?: string;
    parameters?: LlamaCppToolParameterSchema;
  };
};

type JsonSchemaObject = {
  type: 'object';
  properties: JsonObject;
  required: string[];
  additionalProperties: false;
};

function getObject(value: LlamaCppToolParameterSchema | OptionalJsonValue): JsonObject {
  return value && typeof value === 'object' && !Array.isArray(value) ? JsonObjectSchema.parse(value) : {};
}

function getRequired(value: OptionalJsonValue): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
    : [];
}

function buildAnyOf(values: JsonObject[]): JsonObject {
  return values.length === 1 ? values[0] : { anyOf: values };
}

function buildToolCallSchema(toolName: string, parameters: JsonObject): JsonSchemaObject {
  return {
    type: 'object',
    properties: {
      action: { const: toolName },
      ...getObject(parameters.properties),
    },
    required: ['action', ...getRequired(parameters.required)],
    additionalProperties: false,
  };
}

function buildToolCallSchemas(tool: PlannerToolDefinition): JsonSchemaObject[] {
  const parameters = getObject(tool.function.parameters);
  const variants = Array.isArray(parameters.anyOf)
    ? parameters.anyOf.map(getObject).filter((variant) => Object.keys(variant).length > 0)
    : [];
  return (variants.length > 0 ? variants : [parameters])
    .map((variant) => buildToolCallSchema(tool.function.name, variant));
}

function buildToolBatchSchema(toolDefinitions: readonly PlannerToolDefinition[]): JsonSchemaObject {
  return {
    type: 'object',
    properties: {
      action: { const: 'tool_batch' },
      calls: {
        type: 'array',
        minItems: 1,
        items: buildAnyOf(toolDefinitions.flatMap(buildToolCallSchemas)),
      },
    },
    required: ['action', 'calls'],
    additionalProperties: false,
  };
}

export function buildPlannerActionJsonSchema(
  toolDefinitions: readonly PlannerToolDefinition[],
  nonToolActionSchemas: readonly JsonObject[],
): JsonObject {
  const actions = [...nonToolActionSchemas];
  if (toolDefinitions.length > 0) {
    actions.unshift(
      ...toolDefinitions.flatMap(buildToolCallSchemas),
      buildToolBatchSchema(toolDefinitions),
    );
  }
  return buildAnyOf(actions);
}

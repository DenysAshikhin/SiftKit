import { JsonObjectSchema, type JsonObject, type OptionalJsonValue } from '../lib/json-types.js';
import type { LlamaCppToolParameterSchema } from '../llm-protocol/types.js';

export type PlannerToolDefinition = {
  type: 'function';
  exampleArgs: JsonObject;
  function: {
    name: string;
    description: string;
    parameters: LlamaCppToolParameterSchema;
  };
};

export function buildPlannerToolActionExample(tool: PlannerToolDefinition): string {
  return JSON.stringify({
    action: 'tool',
    toolName: tool.function.name,
    args: tool.exampleArgs,
  });
}

type JsonSchemaObject = {
  type: 'object';
  properties: JsonObject;
  required: string[];
  additionalProperties: false;
};

function getObject(value: LlamaCppToolParameterSchema | OptionalJsonValue): JsonObject {
  return value && typeof value === 'object' && !Array.isArray(value) ? JsonObjectSchema.parse(value) : {};
}

function buildAnyOf(values: JsonObject[]): JsonObject {
  return values.length === 1 ? values[0] : { anyOf: values };
}

function buildToolCallSchema(toolName: string, parameters: JsonObject, includeAction: boolean): JsonSchemaObject {
  return {
    type: 'object',
    properties: {
      ...(includeAction ? { action: { const: 'tool' } } : {}),
      toolName: { const: toolName },
      args: parameters,
    },
    required: [...(includeAction ? ['action'] : []), 'toolName', 'args'],
    additionalProperties: false,
  };
}

function buildToolCallSchemas(tool: PlannerToolDefinition, includeAction: boolean): JsonSchemaObject[] {
  const parameters = getObject(tool.function.parameters);
  const variants = Array.isArray(parameters.anyOf)
    ? parameters.anyOf.map(getObject).filter((variant) => Object.keys(variant).length > 0)
    : [];
  return (variants.length > 0 ? variants : [parameters])
    .map((variant) => buildToolCallSchema(tool.function.name, variant, includeAction));
}

function buildToolBatchSchema(toolDefinitions: readonly PlannerToolDefinition[]): JsonSchemaObject {
  return {
    type: 'object',
    properties: {
      action: { const: 'tool_batch' },
      calls: {
        type: 'array',
        minItems: 1,
        items: buildAnyOf(toolDefinitions.flatMap((tool) => buildToolCallSchemas(tool, false))),
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
      ...toolDefinitions.flatMap((tool) => buildToolCallSchemas(tool, true)),
      buildToolBatchSchema(toolDefinitions),
    );
  }
  return buildAnyOf(actions);
}

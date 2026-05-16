export type StructuredOutputToolDefinition = {
  type: 'function';
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
};

type JsonSchema = Record<string, unknown>;

type JsonSchemaObject = {
  type: 'object';
  properties: Record<string, unknown>;
  required: string[];
  additionalProperties: false;
};

function getObjectRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function getRequiredList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0);
}

function getToolArgProperties(tool: StructuredOutputToolDefinition): Record<string, unknown> {
  const parameters = getObjectRecord(tool.function.parameters);
  return getObjectRecord(parameters.properties);
}

function getToolArgRequired(tool: StructuredOutputToolDefinition): string[] {
  const parameters = getObjectRecord(tool.function.parameters);
  return getRequiredList(parameters.required);
}

function buildOneOf(values: JsonSchema[]): JsonSchema {
  if (values.length === 1) {
    return values[0];
  }
  return { oneOf: values };
}

function buildPlannerToolActionSchema(tool: StructuredOutputToolDefinition): JsonSchemaObject {
  return {
    type: 'object',
    properties: {
      action: { const: tool.function.name },
      ...getToolArgProperties(tool),
    },
    required: ['action', ...getToolArgRequired(tool)],
    additionalProperties: false,
  };
}

function buildPlannerToolBatchItemSchema(tool: StructuredOutputToolDefinition): JsonSchemaObject {
  return {
    type: 'object',
    properties: {
      action: { const: tool.function.name },
      ...getToolArgProperties(tool),
    },
    required: ['action', ...getToolArgRequired(tool)],
    additionalProperties: false,
  };
}

function buildPlannerToolBatchActionSchema(toolDefinitions: StructuredOutputToolDefinition[]): JsonSchemaObject {
  return {
    type: 'object',
    properties: {
      action: { const: 'tool_batch' },
      calls: {
        type: 'array',
        minItems: 1,
        items: buildOneOf(toolDefinitions.map((tool) => buildPlannerToolBatchItemSchema(tool))),
      },
    },
    required: ['action', 'calls'],
    additionalProperties: false,
  };
}

function buildSummaryPlannerFinishActionSchema(options: {
  allowUnsupportedInput: boolean;
}): JsonSchemaObject {
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
      ...options.toolDefinitions.map((tool) => buildPlannerToolActionSchema(tool)),
      buildPlannerToolBatchActionSchema(options.toolDefinitions),
    );
  }
  return {
    oneOf: actionSchemas,
  };
}

export function buildSummaryDecisionJsonSchema(options: {
  allowUnsupportedInput: boolean;
}): JsonSchemaObject {
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

export function buildLlamaJsonSchemaResponseFormat(options: {
  name: string;
  schema: JsonSchema;
}): Record<string, unknown> {
  return {
    type: 'json_schema',
    json_schema: {
      name: options.name,
      strict: true,
      schema: options.schema,
    },
  };
}

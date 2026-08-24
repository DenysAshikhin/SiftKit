import {
  JsonValueSchema,
  type JsonObject,
  type MutableJsonObject,
  type OptionalJsonValue,
} from '../lib/json-types.js';
import type { LlamaCppToolParameterSchema } from '../llm-protocol/types.js';
import type { PlannerToolDefinition } from './json-schema.js';

type ParsedPlannerToolCall = {
  toolName: string;
  args: JsonObject;
};

function getRecord(value: LlamaCppToolParameterSchema | OptionalJsonValue): JsonObject | null {
  const result = JsonValueSchema.safeParse(value);
  return result.success && result.data !== null && typeof result.data === 'object' && !Array.isArray(result.data)
    ? result.data
    : null;
}

function getToolDefinition(
  toolDefinitions: readonly PlannerToolDefinition[],
  toolName: string,
): PlannerToolDefinition | null {
  const normalizedToolName = toolName.trim().toLowerCase();
  return toolDefinitions.find(
    ({ function: definition }) => definition.name.trim().toLowerCase() === normalizedToolName,
  ) ?? null;
}

function getDirectToolArgs(parsed: JsonObject, toolDefinition: PlannerToolDefinition): JsonObject {
  const parameters = getRecord(toolDefinition.function.parameters ?? {});
  const properties = getRecord(parameters?.properties);
  const required = new Set(
    Array.isArray(parameters?.required)
      ? parameters.required.filter((entry): entry is string => typeof entry === 'string')
      : [],
  );
  const args: MutableJsonObject = {};
  for (const [key, value] of Object.entries(parsed)) {
    const schemaDeclaresOmission = properties !== null && Object.hasOwn(properties, key) && !required.has(key);
    if (key !== 'action' && (value !== null || !schemaDeclaresOmission)) {
      args[key] = value;
    }
  }
  return args;
}

export function parsePlannerToolAction(
  parsed: JsonObject,
  toolDefinitions: readonly PlannerToolDefinition[],
): ParsedPlannerToolCall | null {
  const action = typeof parsed.action === 'string' ? parsed.action.trim().toLowerCase() : '';
  const toolDefinition = getToolDefinition(toolDefinitions, action);
  return toolDefinition ? { toolName: action, args: getDirectToolArgs(parsed, toolDefinition) } : null;
}

export function parsePlannerToolBatchAction(
  parsed: JsonObject,
  toolDefinitions: readonly PlannerToolDefinition[],
): ParsedPlannerToolCall[] {
  if (!Array.isArray(parsed.calls) || parsed.calls.length === 0) {
    throw new Error('Provider returned an invalid planner tool batch action: "calls" must be a non-empty array');
  }
  return parsed.calls.map((call, index) => {
    const record = getRecord(call);
    if (!record) {
      throw new Error(`Provider returned an invalid planner tool batch action: call ${index + 1} is not a JSON object`);
    }
    const parsedCall = parsePlannerToolAction(record, toolDefinitions);
    if (!parsedCall) {
      const action = typeof record.action === 'string' ? record.action.trim().toLowerCase() : '';
      throw new Error(`Provider returned an invalid planner tool batch action: call ${index + 1} uses unavailable tool "${action}"`);
    }
    return parsedCall;
  });
}

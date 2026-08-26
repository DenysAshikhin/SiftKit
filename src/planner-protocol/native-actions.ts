import type { AgentLoopAction } from '../agent-loop/types.js';
import { isJsonObject, JsonValueSchema, type JsonObject, type JsonValue, type OptionalJsonValue } from '../lib/json-types.js';
import { ModelJson } from '../lib/model-json.js';
import { z } from '../lib/zod.js';
import { LlamaCppToolCallParser } from '../llm-protocol/tool-call-parser.js';
import type { LlamaCppToolCall } from '../llm-protocol/types.js';
import type { PlannerToolDefinition } from './json-schema.js';

export class NativePlannerResponseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NativePlannerResponseError';
  }
}

export class NativePlannerToolCallError extends Error {
  constructor(
    message: string,
    readonly callId: string,
    readonly toolName: string,
    readonly args: JsonObject,
  ) {
    super(message);
    this.name = 'NativePlannerToolCallError';
  }
}

export type NativePlannerResponse = {
  text: string;
  toolCalls: readonly LlamaCppToolCall[];
};

export type NativePlannerActionOptions = {
  toolDefinitions: readonly PlannerToolDefinition[];
  contentWithoutTools: 'finish' | 'invalid';
};

function parseArguments(toolCall: LlamaCppToolCall): JsonObject {
  const parsed = ModelJson.parseToolArguments(toolCall.function.arguments);
  if (parsed) {
    return parsed;
  }
  throw new NativePlannerToolCallError(
    `Tool "${toolCall.function.name}" returned invalid JSON arguments.`,
    toolCall.id,
    toolCall.function.name,
    {},
  );
}

function formatIssuePath(path: PropertyKey[]): string {
  return path.map(String).join('.') || 'arguments';
}

// Models occasionally JSON-stringify a nested array or object argument (the whole
// arguments string already gets the same treatment in ModelJson.parseToolArguments).
// Bounded so a pathological response cannot loop; each round must repair at least
// one field or the original validation error is surfaced.
const MAX_STRINGIFIED_ARGUMENT_REPAIRS = 4;

function readJsonPath(root: JsonObject, path: readonly PropertyKey[]): OptionalJsonValue {
  let current: OptionalJsonValue = root;
  for (const key of path) {
    if (Array.isArray(current) && typeof key === 'number') {
      current = current[key];
    } else if (isJsonObject(current) && typeof key === 'string') {
      current = current[key];
    } else {
      return undefined;
    }
  }
  return current;
}

function writeJsonPath(root: JsonObject, path: readonly PropertyKey[], value: JsonValue): void {
  const parent = readJsonPath(root, path.slice(0, -1));
  const key = path[path.length - 1];
  if (Array.isArray(parent) && typeof key === 'number') {
    parent[key] = value;
  } else if (isJsonObject(parent) && typeof key === 'string') {
    parent[key] = value;
  }
}

function repairStringifiedArguments(args: JsonObject, issues: readonly z.core.$ZodIssue[]): JsonObject | null {
  let repaired: JsonObject | null = null;
  for (const issue of issues) {
    if (issue.code !== 'invalid_type' || (issue.expected !== 'array' && issue.expected !== 'object')) {
      continue;
    }
    const target: JsonObject = repaired ?? structuredClone(args);
    const current = readJsonPath(target, issue.path);
    if (typeof current !== 'string') {
      continue;
    }
    let parsed: JsonValue;
    try {
      parsed = JsonValueSchema.parse(JSON.parse(current));
    } catch {
      continue;
    }
    const matchesExpected = issue.expected === 'array' ? Array.isArray(parsed) : isJsonObject(parsed);
    if (!matchesExpected) {
      continue;
    }
    writeJsonPath(target, issue.path, parsed);
    repaired = target;
  }
  return repaired;
}

function parseDefinitionArguments<T>(
  toolCall: LlamaCppToolCall,
  args: JsonObject,
  argumentSchema: z.ZodType<T>,
): T {
  let candidate = args;
  let validated = argumentSchema.safeParse(candidate);
  for (let repairs = 0; !validated.success && repairs < MAX_STRINGIFIED_ARGUMENT_REPAIRS; repairs += 1) {
    const repaired = repairStringifiedArguments(candidate, validated.error.issues);
    if (repaired === null) {
      break;
    }
    candidate = repaired;
    validated = argumentSchema.safeParse(candidate);
  }
  if (validated.success) {
    return validated.data;
  }
  const issue = validated.error.issues[0];
  const detail = issue?.message ?? validated.error.message;
  throw new NativePlannerToolCallError(
    `Tool "${toolCall.function.name.trim()}" has invalid "${formatIssuePath(issue?.path ?? [])}": ${detail}`,
    toolCall.id,
    toolCall.function.name.trim(),
    args,
  );
}

function parseToolAction(
  toolCall: LlamaCppToolCall,
  options: NativePlannerActionOptions,
): AgentLoopAction {
  const toolName = toolCall.function.name.trim();
  const args = parseArguments(toolCall);
  const definition = options.toolDefinitions.find((candidate) => candidate.function.name === toolName);
  if (!definition) {
    const allowed = options.toolDefinitions.map((candidate) => candidate.function.name).join(', ');
    throw new NativePlannerToolCallError(
      `Unknown or disallowed tool "${toolName}". Allowed tools: ${allowed}.`,
      toolCall.id,
      toolName,
      args,
    );
  }

  if (definition.kind === 'finish') {
    return parseDefinitionArguments(toolCall, args, definition.argumentSchema);
  }
  const validatedArgs = parseDefinitionArguments(toolCall, args, definition.argumentSchema);

  return {
    kind: 'tool',
    callId: toolCall.id,
    toolName,
    args: validatedArgs,
  };
}

export function parseNativePlannerActions(
  response: NativePlannerResponse,
  options: NativePlannerActionOptions,
): AgentLoopAction[] {
  const content = response.text.trim();
  const fallbackScan = response.toolCalls.length === 0 && content
    ? new LlamaCppToolCallParser().scanFromText(content)
    : null;
  const toolCalls = response.toolCalls.length > 0
    ? response.toolCalls
    : fallbackScan === null ? [] : fallbackScan.calls;
  if (toolCalls.length === 0) {
    if (!content) {
      throw new NativePlannerResponseError('Planner returned neither content nor tool calls.');
    }
    if (fallbackScan !== null && fallbackScan.sawBareMarkup) {
      const rejection = 'Planner returned malformed tool-call markup that could not be parsed. Re-emit the tool call as valid markup';
      throw new NativePlannerResponseError(
        options.contentWithoutTools === 'finish'
          ? `${rejection}, or finish by returning the answer with any markup examples quoted in backticks.`
          : `${rejection}.`,
      );
    }
    if (options.contentWithoutTools === 'invalid') {
      throw new NativePlannerResponseError('Planner returned content without a valid tool call.');
    }
    return [{ kind: 'finish', text: content }];
  }

  return toolCalls.map((toolCall) => parseToolAction(toolCall, options));
}

import type { AgentLoopAction } from '../agent-loop/types.ts';
import { toError } from '../lib/errors.ts';
import { isJsonObject, JsonValueSchema, type JsonObject, type JsonValue, type OptionalJsonValue } from '../lib/json-types.ts';
import { ModelJson } from '../lib/model-json.ts';
import { z } from '../lib/zod.ts';
import { InferenceToolCallParser } from '../llm-protocol/tool-call-parser.ts';
import type { LiveContentClassification, InferenceToolCall } from '../llm-protocol/types.ts';
import type { PlannerToolDefinition } from './json-schema.ts';

export class NativePlannerResponseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NativePlannerResponseError';
  }
}

export class NativePlannerToolCallError extends Error {
  readonly callId: string;
  readonly toolName: string;
  readonly args: JsonObject;

  constructor(
    message: string,
    callId: string,
    toolName: string,
    args: JsonObject,
  ) {
    super(message);
    this.callId = callId;
    this.toolName = toolName;
    this.args = args;
    this.name = 'NativePlannerToolCallError';
  }
}

export type NativePlannerResponse = {
  text: string;
  rawText: string;
  narrationText: string;
  classification: LiveContentClassification;
  toolCalls: readonly InferenceToolCall[];
};

export type NativePlannerActionOptions = {
  toolDefinitions: readonly PlannerToolDefinition[];
  contentWithoutTools: 'finish' | 'invalid';
};

function parseArguments(toolCall: InferenceToolCall): JsonObject {
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

/** Why a string the model sent for an array or object did not repair: its JSON parse error and the text around it. */
function describeUnparsedJson(args: JsonObject, issue: z.core.$ZodIssue | undefined): string {
  if (issue?.code !== 'invalid_type' || (issue.expected !== 'array' && issue.expected !== 'object')) return '';
  const value = readJsonPath(args, issue.path);
  if (typeof value !== 'string') return '';
  try {
    JSON.parse(value);
    return '';
  } catch (error) {
    const message = toError(error).message;
    const position = Number(/position (\d+)/u.exec(message)?.[1] ?? Number.NaN);
    const near = Number.isNaN(position) ? '' : `, near: ${value.slice(Math.max(0, position - 20), position + 10)}`;
    return `; the string is not valid JSON: ${message}${near}`;
  }
}

function parseDefinitionArguments<T>(
  toolCall: InferenceToolCall,
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
    `Tool "${toolCall.function.name.trim()}" has invalid "${formatIssuePath(issue?.path ?? [])}": ${detail}${describeUnparsedJson(candidate, issue)}`,
    toolCall.id,
    toolCall.function.name.trim(),
    args,
  );
}

function parseToolAction(
  toolCall: InferenceToolCall,
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
  const content = response.narrationText.trim();
  const rawContent = response.rawText.trim();
  const fallbackScan = response.toolCalls.length === 0 && rawContent
    ? new InferenceToolCallParser().scanFromText(rawContent)
    : null;
  const toolCalls = response.toolCalls.length > 0
    ? response.toolCalls
    : fallbackScan === null ? [] : fallbackScan.calls;
  if (toolCalls.length === 0) {
    if (!rawContent) {
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
    if (!content) {
      throw new NativePlannerResponseError(
        'Planner returned no answer content: the response had no narration to finish with.',
      );
    }
    return [{ kind: 'finish', text: content }];
  }

  return toolCalls.map((toolCall) => parseToolAction(toolCall, options));
}

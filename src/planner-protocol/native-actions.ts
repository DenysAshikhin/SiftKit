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

/** The schema node a field path leads to in a tool's JSON-schema parameters. */
function readSchemaPath(parameters: JsonObject, path: readonly PropertyKey[]): OptionalJsonValue {
  let node: OptionalJsonValue = parameters;
  for (const key of path) {
    const current = firstVariant(node);
    if (!isJsonObject(current)) return undefined;
    node = typeof key === 'number' ? current.items : isJsonObject(current.properties) ? current.properties[String(key)] : undefined;
  }
  return node;
}

/** An optional or nullable field is a union; its first non-null branch is the shape to show. */
function firstVariant(node: OptionalJsonValue): OptionalJsonValue {
  if (!isJsonObject(node) || !Array.isArray(node.anyOf)) return node;
  return node.anyOf.find((branch) => !(isJsonObject(branch) && branch.type === 'null'));
}

// Deep enough to show an array of objects and their fields; anything deeper is elided.
const MAX_SHAPE_DEPTH = 2;

/** A compact example of the JSON a schema node accepts. */
function describeShape(schemaNode: OptionalJsonValue, depth: number): string {
  const node = firstVariant(schemaNode);
  if (!isJsonObject(node)) return '…';
  if (node.type === 'array') return depth >= MAX_SHAPE_DEPTH ? '[…]' : `[${describeShape(node.items, depth + 1)}]`;
  if (node.type === 'object' && isJsonObject(node.properties)) {
    if (depth >= MAX_SHAPE_DEPTH) return '{…}';
    return `{${Object.entries(node.properties).map(([key, value]) => `"${key}": ${describeShape(value, depth + 1)}`).join(', ')}}`;
  }
  if (node.type === 'string') return '"…"';
  if (node.type === 'number' || node.type === 'integer') return '0';
  return node.type === 'boolean' ? 'false' : '…';
}

/** For a field of the wrong structure, the shape it expects, so the model can resend it right. */
function describeExpectedShape(parameters: JsonObject, issue: z.core.$ZodIssue | undefined): string {
  if (issue?.code !== 'invalid_type' || (issue.expected !== 'array' && issue.expected !== 'object')) return '';
  return `; expected shape: ${describeShape(readSchemaPath(parameters, issue.path), 0)}`;
}

/** The whole arguments object a model sent inside its only argument, as JSON text or an object. */
function readWrappedArguments(args: JsonObject, parameters: JsonObject): JsonObject | null {
  const values = Object.values(args);
  if (values.length !== 1) return null;
  let inner: OptionalJsonValue = values[0];
  if (typeof inner === 'string') {
    try {
      inner = JsonValueSchema.parse(JSON.parse(inner));
    } catch {
      return null;
    }
  }
  const names = isJsonObject(parameters.properties) ? Object.keys(parameters.properties) : [];
  if (!isJsonObject(inner) || Object.keys(inner).length === 0) return null;
  return Object.keys(inner).every((key) => names.includes(key)) ? inner : null;
}

function validateArguments<T>(args: JsonObject, argumentSchema: z.ZodType<T>): { candidate: JsonObject; validated: z.ZodSafeParseResult<T> } {
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
  return { candidate, validated };
}

function parseDefinitionArguments<T>(
  toolCall: InferenceToolCall,
  args: JsonObject,
  argumentSchema: z.ZodType<T>,
  parameters: JsonObject,
): T {
  const direct = validateArguments(args, argumentSchema);
  const wrapped = direct.validated.success ? null : readWrappedArguments(args, parameters);
  const { candidate, validated } = wrapped === null ? direct : validateArguments(wrapped, argumentSchema);
  if (validated.success) {
    return validated.data;
  }
  const issue = validated.error.issues[0];
  const detail = issue?.message ?? validated.error.message;
  throw new NativePlannerToolCallError(
    `Tool "${toolCall.function.name.trim()}" has invalid "${formatIssuePath(issue?.path ?? [])}": ${detail}`
      + `${describeUnparsedJson(candidate, issue)}${describeExpectedShape(parameters, issue)}`,
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
    return parseDefinitionArguments(toolCall, args, definition.argumentSchema, definition.function.parameters);
  }
  const validatedArgs = parseDefinitionArguments(toolCall, args, definition.argumentSchema, definition.function.parameters);

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

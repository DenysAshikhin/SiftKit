import type { AgentLoopAction } from '../agent-loop/types.js';
import type { JsonObject } from '../lib/json-types.js';
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

function parseDefinitionArguments<T>(
  toolCall: LlamaCppToolCall,
  args: JsonObject,
  argumentSchema: z.ZodType<T>,
): T {
  const validated = argumentSchema.safeParse(args);
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

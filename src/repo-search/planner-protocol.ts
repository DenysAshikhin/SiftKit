import * as http from 'node:http';
import * as https from 'node:https';
import { requestJsonFull } from '../lib/http.js';
import {
  buildTransientProviderHttpError,
  buildProviderErrorMessage,
  getCompletionUsageFromResponseBody,
  getPromptUsageFromResponseBody,
  isTransientProviderHttpResponse,
  normalizeProviderText,
  retryProviderRequest,
  serializeNetworkError,
} from '../lib/provider-helpers.js';
import { stripCodeFence } from '../lib/text-format.js';
import {
  REPO_SEARCH_PIPE_COMMANDS,
  REPO_SEARCH_PRODUCER_COMMANDS,
  getFirstCommandToken,
} from './command-safety.js';
import {
  buildFinishValidationJsonSchema,
  buildLlamaJsonSchemaResponseFormat,
  buildRepoSearchPlannerActionJsonSchema,
  type StructuredOutputToolDefinition,
} from '../providers/structured-output-schema.js';
import type { JsonLogger } from './types.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type PlannerActionResponse = {
  text: string;
  thinkingText: string;
  mockExhausted: boolean;
  nextMockResponseIndex?: number;
  promptTokens?: number | null;
  completionTokens?: number | null;
  usageThinkingTokens?: number | null;
  promptCacheTokens?: number | null;
  promptEvalTokens?: number | null;
  promptEvalDurationMs?: number | null;
  generationDurationMs?: number | null;
};

export type ToolAction = {
  action: 'tool';
  tool_name: string;
  args: Record<string, unknown>;
};

export type ToolBatchAction = {
  action: 'tool_batch';
  tool_calls: Array<{
    tool_name: string;
    args: Record<string, unknown>;
  }>;
};

export type FinishAction = {
  action: 'finish';
  output: string;
  confidence?: number;
};

export type PlannerAction = ToolAction | ToolBatchAction | FinishAction;

export type FinishValidationResult = {
  verdict: 'pass' | 'fail';
  reason: string;
};

export type ChatMessage = {
  role: string;
  content?: string;
  reasoning_content?: string;
  tool_calls?: Array<{
    id: string;
    type: string;
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
};

// ---------------------------------------------------------------------------
// Provider response content extraction
// ---------------------------------------------------------------------------

function extractChoiceContent(choice: Record<string, unknown>): {
  text: string;
  thinkingText: string;
} {
  const message = choice?.message as Record<string, unknown> | undefined;
  const rawText = normalizeProviderText(message?.content) || normalizeProviderText(choice?.text) || '';
  const reasoningContent = normalizeProviderText(message?.reasoning_content) || normalizeProviderText(choice?.reasoning_content) || '';
  // If no dedicated reasoning_content, try to extract <think>...</think> from the text
  if (!reasoningContent && rawText.includes('<think>')) {
    const { thinkingText, text } = extractInlineThinking(rawText);
    return { text, thinkingText };
  }
  return { text: rawText, thinkingText: reasoningContent };
}

/** Extract <think>...</think> blocks from inline content and return cleaned text. */
function extractInlineThinking(raw: string): { thinkingText: string; text: string } {
  const thinkPattern = /<think>([\s\S]*?)<\/think>/gu;
  const thinkingParts: string[] = [];
  let match;
  thinkPattern.lastIndex = 0;
  while ((match = thinkPattern.exec(raw)) !== null) {
    thinkingParts.push(match[1]);
  }
  const text = raw.replace(/<think>[\s\S]*?<\/think>/gu, '').trim();
  return { thinkingText: thinkingParts.join('\n').trim(), text };
}

// ---------------------------------------------------------------------------
// Tool definitions exposed to the LLM
// ---------------------------------------------------------------------------

const LEGACY_REPO_SEARCH_TOOL_ALIAS = 'run_repo_cmd';
const NATIVE_REPO_SEARCH_TOOL_REGISTRY: Record<string, StructuredOutputToolDefinition> = {
  repo_read_file: {
    type: 'function',
    function: {
      name: 'repo_read_file',
      description: 'Read one repository file with optional 1-based line bounds.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          startLine: { type: 'integer' },
          endLine: { type: 'integer' },
        },
        required: ['path'],
      },
    },
  },
  repo_list_files: {
    type: 'function',
    function: {
      name: 'repo_list_files',
      description: 'List repository files under an optional path, with optional glob filtering and recursion control.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          glob: { type: 'string' },
          recurse: { type: 'boolean' },
        },
        required: [],
      },
    },
  },
};

const REPO_SEARCH_EXCLUDED_COMMAND_TOKENS = new Set<string>([
  'get-content',
  'get-childitem',
  'select-string',
  'pwd',
  'ls',
]);
const ACCEPTED_REPO_SEARCH_COMMAND_TOKENS: readonly string[] = [
  ...new Set<string>([
    ...REPO_SEARCH_PRODUCER_COMMANDS,
    ...REPO_SEARCH_PIPE_COMMANDS,
  ]),
];

const REPO_SEARCH_COMMAND_TOKENS: readonly string[] = [
  ...new Set<string>([
    ...REPO_SEARCH_PRODUCER_COMMANDS.filter((commandToken) => !REPO_SEARCH_EXCLUDED_COMMAND_TOKENS.has(commandToken)),
    ...REPO_SEARCH_PIPE_COMMANDS.filter((commandToken) => !REPO_SEARCH_EXCLUDED_COMMAND_TOKENS.has(commandToken)),
  ]),
];

function commandTokenToToolName(commandToken: string): string {
  return `repo_${String(commandToken || '').trim().toLowerCase().replace(/[^a-z0-9]+/gu, '_')}`;
}

function buildRepoSearchToolDescription(commandToken: string): string {
  return `Run one read-only repo command that starts with '${commandToken}'.`;
}

const COMMAND_REPO_SEARCH_TOOL_REGISTRY: Record<string, StructuredOutputToolDefinition> = Object.fromEntries(
  REPO_SEARCH_COMMAND_TOKENS.map((commandToken) => {
    const toolName = commandTokenToToolName(commandToken);
    return [toolName, {
      type: 'function',
      function: {
        name: toolName,
        description: buildRepoSearchToolDescription(commandToken),
        parameters: {
          type: 'object',
          properties: { command: { type: 'string' } },
          required: ['command'],
        },
      },
    }];
  }),
) as Record<string, StructuredOutputToolDefinition>;

const REPO_SEARCH_TOOL_REGISTRY: Record<string, StructuredOutputToolDefinition> = {
  ...NATIVE_REPO_SEARCH_TOOL_REGISTRY,
  ...COMMAND_REPO_SEARCH_TOOL_REGISTRY,
};

const REPO_SEARCH_TOOL_NAME_BY_COMMAND_TOKEN = new Map<string, string>(
  ACCEPTED_REPO_SEARCH_COMMAND_TOKENS.map((commandToken) => [commandToken, commandTokenToToolName(commandToken)]),
);

const REPO_SEARCH_COMMAND_TOKEN_BY_TOOL_NAME = new Map<string, string>(
  ACCEPTED_REPO_SEARCH_COMMAND_TOKENS.map((commandToken) => [commandTokenToToolName(commandToken), commandToken]),
);

export function getRepoSearchToolNames(): string[] {
  return Object.keys(REPO_SEARCH_TOOL_REGISTRY);
}

export function getRepoSearchToolNamesForParsing(): string[] {
  return Array.from(new Set<string>([
    ...Object.keys(REPO_SEARCH_TOOL_REGISTRY),
    ...Array.from(REPO_SEARCH_COMMAND_TOKEN_BY_TOOL_NAME.keys()),
  ]));
}

export function isRepoSearchNativeToolName(toolName: string): boolean {
  return Object.prototype.hasOwnProperty.call(
    NATIVE_REPO_SEARCH_TOOL_REGISTRY,
    String(toolName || '').trim().toLowerCase(),
  );
}

export function isRepoSearchCommandToolName(toolName: string): boolean {
  return REPO_SEARCH_COMMAND_TOKEN_BY_TOOL_NAME.has(String(toolName || '').trim().toLowerCase());
}

export function getRepoSearchCommandTokenForToolName(toolName: string): string | null {
  return REPO_SEARCH_COMMAND_TOKEN_BY_TOOL_NAME.get(String(toolName || '').trim().toLowerCase()) || null;
}

export function getRepoSearchToolNameForCommand(command: string): string | null {
  const commandToken = getFirstCommandToken(String(command || '').trim());
  return REPO_SEARCH_TOOL_NAME_BY_COMMAND_TOKEN.get(commandToken) || null;
}

export function resolveRepoSearchPlannerToolDefinitions(
  allowedToolNames?: readonly string[],
): StructuredOutputToolDefinition[] {
  if (Array.isArray(allowedToolNames)) {
    const resolved = allowedToolNames
      .map((toolName) => REPO_SEARCH_TOOL_REGISTRY[String(toolName || '').trim().toLowerCase()])
      .filter((toolDefinition): toolDefinition is StructuredOutputToolDefinition => Boolean(toolDefinition));
    return resolved;
  }
  return Object.values(REPO_SEARCH_TOOL_REGISTRY);
}

export const TOOL_DEFINITIONS = resolveRepoSearchPlannerToolDefinitions();

// ---------------------------------------------------------------------------
// Action parsing
// ---------------------------------------------------------------------------

function decodeJsonStringLoose(raw: string): string {
  let decoded = '';
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i];
    if (ch !== '\\') { decoded += ch; continue; }
    if (i + 1 >= raw.length) { decoded += '\\'; continue; }
    const next = raw[i + 1];
    i += 1;
    if (next === '"' || next === '\\' || next === '/') { decoded += next; continue; }
    if (next === 'b') { decoded += '\b'; continue; }
    if (next === 'f') { decoded += '\f'; continue; }
    if (next === 'n') { decoded += '\n'; continue; }
    if (next === 'r') { decoded += '\r'; continue; }
    if (next === 't') { decoded += '\t'; continue; }
    if (next === 'u' && i + 4 < raw.length) {
      const hex = raw.slice(i + 1, i + 5);
      if (/^[0-9a-fA-F]{4}$/u.test(hex)) {
        decoded += String.fromCharCode(Number.parseInt(hex, 16));
        i += 4;
        continue;
      }
    }
    decoded += next;
  }
  return decoded;
}

function getCommandArgValue(args: Record<string, unknown>): string {
  const commandValue = typeof args.command === 'string'
    ? args.command
    : typeof args.cmd === 'string'
      ? args.cmd
      : '';
  return commandValue.trim();
}

function normalizeRepoSearchToolCall(
  rawToolName: string,
  rawArgs: Record<string, unknown>,
  allowedToolNames: Set<string>,
): ToolAction | null {
  const normalizedRawToolName = String(rawToolName || '').trim().toLowerCase();
  let toolName = normalizedRawToolName;
  if (toolName === LEGACY_REPO_SEARCH_TOOL_ALIAS) {
    const command = getCommandArgValue(rawArgs);
    if (!command) {
      return null;
    }
    const inferredToolName = getRepoSearchToolNameForCommand(command);
    if (!inferredToolName) {
      return null;
    }
    toolName = inferredToolName;
  }
  if (!allowedToolNames.has(toolName)) {
    return null;
  }
  if (isRepoSearchCommandToolName(toolName)) {
    const command = getCommandArgValue(rawArgs);
    if (!command) {
      return null;
    }
    const expectedCommandToken = getRepoSearchCommandTokenForToolName(toolName);
    const actualCommandToken = getFirstCommandToken(command);
    if (!expectedCommandToken || actualCommandToken !== expectedCommandToken) {
      return null;
    }
    return {
      action: 'tool',
      tool_name: toolName,
      args: { command },
    };
  }
  if (toolName === 'repo_read_file') {
    return typeof rawArgs.path === 'string' && rawArgs.path.trim()
      ? {
        action: 'tool',
        tool_name: toolName,
        args: {
          path: rawArgs.path,
          ...(rawArgs.startLine === undefined ? {} : { startLine: rawArgs.startLine }),
          ...(rawArgs.endLine === undefined ? {} : { endLine: rawArgs.endLine }),
        },
      }
      : null;
  }
  if (toolName === 'repo_list_files') {
    return {
      action: 'tool',
      tool_name: toolName,
      args: {
        ...(typeof rawArgs.path === 'string' ? { path: rawArgs.path } : {}),
        ...(typeof rawArgs.glob === 'string' ? { glob: rawArgs.glob } : {}),
        ...(typeof rawArgs.recurse === 'boolean' ? { recurse: rawArgs.recurse } : {}),
      },
    };
  }
  return {
    action: 'tool',
    tool_name: toolName,
    args: rawArgs,
  };
}

function tryRecoverMalformedPlannerToolAction(rawText: string, allowedToolNames: Set<string>): ToolAction | null {
  if (!/"action"\s*:\s*"tool"/iu.test(rawText)) {
    return null;
  }
  const toolNameMatch = /"tool_name"\s*:\s*"([^"]+)"/iu.exec(rawText);
  const toolName = String(toolNameMatch?.[1] || '').trim().toLowerCase();
  if (!toolName) {
    return null;
  }
  const commandMatch = /"command"\s*:\s*"([\s\S]*)"\s*\}\s*\}\s*$/u.exec(rawText);
  if (!commandMatch?.[1]) return null;
  const recoveredCommand = decodeJsonStringLoose(commandMatch[1]).trim();
  if (!recoveredCommand) return null;
  return normalizeRepoSearchToolCall(toolName, { command: recoveredCommand }, allowedToolNames);
}

function parseRepoToolCallCandidate(toolCall: {
  function?: { name?: string; arguments?: unknown };
  name?: string;
  arguments?: unknown;
} | null | undefined, allowedToolNames: Set<string>): ToolAction | null {
  const name = typeof toolCall?.function?.name === 'string' ? toolCall.function.name
    : typeof toolCall?.name === 'string' ? toolCall.name : '';

  let args = toolCall?.function?.arguments ?? toolCall?.arguments;
  if (typeof args === 'string') { try { args = JSON.parse(args); } catch { return null; } }
  if (!args || typeof args !== 'object' || Array.isArray(args)) return null;
  const normalizedArgs = args as Record<string, unknown>;
  return normalizeRepoSearchToolCall(name, normalizedArgs, allowedToolNames);
}

function actionFromToolCall(choice: Record<string, unknown>, allowedToolNames: Set<string>): string | null {
  type ToolCallLike = { function?: { name?: string; arguments?: unknown }; name?: string; arguments?: unknown };
  const message = choice?.message as Record<string, unknown> | undefined;
  const toolCalls = [
    ...(((message?.tool_calls as ToolCallLike[] | undefined) || []).map((toolCall) => parseRepoToolCallCandidate(toolCall, allowedToolNames)).filter(Boolean) as ToolAction[]),
    ...((((choice?.tool_calls as ToolCallLike[] | undefined) || []).map((toolCall) => parseRepoToolCallCandidate(toolCall, allowedToolNames)).filter(Boolean)) as ToolAction[]),
  ];
  const functionCall = parseRepoToolCallCandidate(
    (message?.function_call as ToolCallLike | undefined) ?? (choice?.function_call as ToolCallLike | undefined),
    allowedToolNames,
  );
  if (functionCall) {
    toolCalls.push(functionCall);
  }
  if (toolCalls.length === 0) return null;
  if (toolCalls.length === 1) {
    return JSON.stringify(toolCalls[0]);
  }
  return JSON.stringify({
    action: 'tool_batch',
    tool_calls: toolCalls.map((toolCall) => ({
      tool_name: toolCall.tool_name,
      args: toolCall.args,
    })),
  });
}

export function parsePlannerAction(text: string, options?: {
  allowedToolNames?: readonly string[];
}): PlannerAction {
  const allowedToolNameSet = new Set<string>(
    Array.isArray(options?.allowedToolNames) && options.allowedToolNames.length > 0
      ? options.allowedToolNames.map((toolName) => String(toolName || '').trim().toLowerCase())
      : TOOL_DEFINITIONS.map((toolDefinition) => toolDefinition.function.name),
  );
  const normalized = stripCodeFence(text);
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(normalized) as Record<string, unknown>;
  } catch (error) {
    const recovered = tryRecoverMalformedPlannerToolAction(normalized, allowedToolNameSet);
    if (recovered) return recovered;
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Provider returned an invalid planner payload: ${message}`);
  }

  const action = typeof parsed.action === 'string' ? parsed.action.trim().toLowerCase() : '';

  if (action === 'tool') {
    // Accept tool_name variants: tool_name, toolName, tool, name
    const toolName = String(
      parsed.tool_name ?? parsed.toolName ?? parsed.tool ?? parsed.name ?? '',
    ).trim().toLowerCase();
    if (!parsed.args || typeof parsed.args !== 'object' || Array.isArray(parsed.args)) {
      throw new Error('Provider returned an invalid planner tool action.');
    }
    const args = parsed.args as Record<string, unknown>;
    const normalizedToolAction = normalizeRepoSearchToolCall(toolName, args, allowedToolNameSet);
    if (!normalizedToolAction) {
      throw new Error('Provider returned an invalid planner tool action.');
    }
    return normalizedToolAction;
  }

  if (action === 'tool_batch') {
    if (!Array.isArray(parsed.tool_calls) || parsed.tool_calls.length === 0) {
      throw new Error('Provider returned an invalid planner tool batch action.');
    }
    const toolCalls = parsed.tool_calls.map((toolCall) => {
      if (!toolCall || typeof toolCall !== 'object' || Array.isArray(toolCall)) {
        throw new Error('Provider returned an invalid planner tool batch action.');
      }
      const toolRecord = toolCall as Record<string, unknown>;
      const toolName = String(
        toolRecord.tool_name ?? toolRecord.toolName ?? toolRecord.tool ?? toolRecord.name ?? '',
      ).trim().toLowerCase();
      if (!toolRecord.args || typeof toolRecord.args !== 'object' || Array.isArray(toolRecord.args)) {
        throw new Error('Provider returned an invalid planner tool batch action.');
      }
      const args = toolRecord.args as Record<string, unknown>;
      const normalizedToolAction = normalizeRepoSearchToolCall(toolName, args, allowedToolNameSet);
      if (!normalizedToolAction) {
        throw new Error('Provider returned an invalid planner tool batch action.');
      }
      return {
        tool_name: normalizedToolAction.tool_name,
        args: normalizedToolAction.args,
      };
    });
    return {
      action: 'tool_batch',
      tool_calls: toolCalls,
    };
  }

  if (action === 'finish') {
    if (typeof parsed.output !== 'string' || !parsed.output.trim()) {
      throw new Error('Provider returned an invalid planner finish action.');
    }
    const confidence = Number(parsed.confidence);
    return Number.isFinite(confidence)
      ? { action: 'finish', output: parsed.output.trim(), confidence }
      : { action: 'finish', output: parsed.output.trim() };
  }

  throw new Error('Provider returned an unknown planner action.');
}

// ---------------------------------------------------------------------------
// Unified LLM request function (non-streaming + streaming via `stream` param)
// ---------------------------------------------------------------------------

export type PlannerRequestOptions = {
  baseUrl: string;
  model: string;
  messages: ChatMessage[];
  slotId?: number;
  timeoutMs: number;
  requestMaxTokens: number;
  thinkingEnabled?: boolean;
  reasoningContentEnabled?: boolean;
  preserveThinking?: boolean;
  /** When true, use server-sent-events streaming. */
  stream?: boolean;
  /** Called with accumulated thinking text on each streaming delta. */
  onThinkingDelta?: (accumulatedThinking: string) => void;
  /** Called with accumulated content text on each streaming delta. */
  onContentDelta?: (accumulatedContent: string) => void;
  /** Mock response array for testing — bypasses the network entirely. */
  mockResponses?: string[];
  mockResponseIndex?: number;
  logger?: JsonLogger | null;
  /** Override stage name for logging (default: 'planner_action'). */
  stage?: string;
  /** Override the response schema. Pass null to omit response_format. */
  responseSchema?: Record<string, unknown> | null;
  /** Override the response-format schema name. */
  responseSchemaName?: string;
  /** Available tools for planner_action stage. */
  toolDefinitions?: StructuredOutputToolDefinition[];
  /** Extra fields merged into the request body. */
  extraBody?: Record<string, unknown>;
};

function logProviderRetry(options: {
  logger?: JsonLogger | null;
  stage: string;
  method: string;
  url: string;
  path: string;
  attempt: number;
  elapsedMs: number;
  nextDelayMs: number;
  error: ReturnType<typeof serializeNetworkError>;
}): void {
  options.logger?.write({
    kind: 'provider_request_retry',
    stage: options.stage,
    method: options.method,
    url: options.url,
    path: options.path,
    attempt: options.attempt,
    elapsedMs: options.elapsedMs,
    nextDelayMs: options.nextDelayMs,
    error: options.error,
  });
}

function serializePlannerMessage(message: ChatMessage, reasoningContentEnabled: boolean): ChatMessage {
  if (
    reasoningContentEnabled
    && message.role === 'assistant'
    && typeof message.reasoning_content === 'string'
    && message.reasoning_content.trim()
  ) {
    return message;
  }
  if (!Object.prototype.hasOwnProperty.call(message, 'reasoning_content')) {
    return message;
  }
  const { reasoning_content: _reasoningContent, ...rest } = message;
  return rest;
}

export async function requestPlannerAction(options: PlannerRequestOptions): Promise<PlannerActionResponse> {
  // Mock path — bypass network entirely
  if (Array.isArray(options.mockResponses)) {
    const index = options.mockResponseIndex || 0;
    if (index >= options.mockResponses.length) {
      return { text: '', thinkingText: '', mockExhausted: true };
    }
    return { text: options.mockResponses[index], thinkingText: '', mockExhausted: false, nextMockResponseIndex: index + 1 };
  }

  const stage = options.stage || 'planner_action';
  const toolDefinitions = Array.isArray(options.toolDefinitions) && options.toolDefinitions.length > 0
    ? options.toolDefinitions
    : TOOL_DEFINITIONS;
  const allowedToolNames = new Set<string>(toolDefinitions.map((toolDefinition) => toolDefinition.function.name));
  const includeTools = stage === 'planner_action' && toolDefinitions.length > 0;
  const defaultResponseSchema = stage === 'planner_action'
    ? buildRepoSearchPlannerActionJsonSchema({ toolDefinitions })
    : stage === 'finish_validation'
      ? buildFinishValidationJsonSchema()
      : null;
  const responseSchema = options.responseSchema === undefined
    ? defaultResponseSchema
    : options.responseSchema;
  const responseFormat = responseSchema === null
    ? null
    : buildLlamaJsonSchemaResponseFormat({
      name: options.responseSchemaName || (stage === 'finish_validation' ? 'siftkit_finish_validation' : 'siftkit_repo_search_planner_action'),
      schema: responseSchema,
    });

  const bodyObj: Record<string, unknown> = {
    model: options.model,
    messages: options.messages.map((message) => serializePlannerMessage(message, options.reasoningContentEnabled === true)),
    cache_prompt: true,
    ...(Number.isInteger(options.slotId) ? { id_slot: Number(options.slotId) } : {}),
    temperature: 0.1,
    top_p: 0.95,
    max_tokens: options.requestMaxTokens,
    ...(includeTools ? { tools: toolDefinitions, parallel_tool_calls: true } : {}),
    chat_template_kwargs: {
      enable_thinking: Boolean(options.thinkingEnabled),
      ...(options.thinkingEnabled && options.reasoningContentEnabled ? { reasoning_content: true } : {}),
      ...(options.thinkingEnabled && options.reasoningContentEnabled && options.preserveThinking ? { preserve_thinking: true } : {}),
    },
    ...(responseFormat ? { response_format: responseFormat } : {}),
    ...options.extraBody,
    ...(options.stream ? { stream: true } : {}),
  };
  const bodyJson = JSON.stringify(bodyObj);

  // Streaming path
  if (options.stream) {
    return retryProviderRequest(
      () => requestStreaming(options, bodyJson, stage),
      {
        onRetry(event) {
          logProviderRetry({
            logger: options.logger,
            stage,
            method: 'POST',
            url: `${options.baseUrl.replace(/\/$/u, '')}/v1/chat/completions`,
            path: '/v1/chat/completions',
            attempt: event.attempt,
            elapsedMs: event.elapsedMs,
            nextDelayMs: event.nextDelayMs,
            error: event.error,
          });
        },
      },
    );
  }

  // Non-streaming path — use shared requestJsonFull
  type CompletionBody = Record<string, unknown> & { choices?: Array<Record<string, unknown>> };
  const requestUrl = `${options.baseUrl.replace(/\/$/u, '')}/v1/chat/completions`;
  const urlPath = new URL(requestUrl).pathname;
  const startedAt = Date.now();
  options.logger?.write({ kind: 'provider_request_start', stage, method: 'POST', url: requestUrl, path: urlPath });

  let response;
  try {
    response = await retryProviderRequest(
      async () => {
        const nextResponse = await requestJsonFull<CompletionBody>({
          url: requestUrl,
          method: 'POST',
          timeoutMs: options.timeoutMs,
          body: bodyJson,
        });
        if (isTransientProviderHttpResponse(nextResponse.statusCode, nextResponse.rawText)) {
          throw buildTransientProviderHttpError(nextResponse.statusCode, nextResponse.rawText);
        }
        return nextResponse;
      },
      {
        onRetry(event) {
          logProviderRetry({
            logger: options.logger,
            stage,
            method: 'POST',
            url: requestUrl,
            path: urlPath,
            attempt: event.attempt,
            elapsedMs: event.elapsedMs,
            nextDelayMs: event.nextDelayMs,
            error: event.error,
          });
        },
      },
    );
  } catch (error) {
    const serialized = serializeNetworkError(error);
    options.logger?.write({
      kind: 'provider_request_error', stage, method: 'POST', url: requestUrl,
      path: urlPath, elapsedMs: Date.now() - startedAt, error: serialized,
    });
    throw new Error(buildProviderErrorMessage({ stage, method: 'POST', url: requestUrl }, serialized));
  }

  options.logger?.write({ kind: 'provider_request_done', stage, method: 'POST', url: requestUrl, path: urlPath, statusCode: response.statusCode, elapsedMs: Date.now() - startedAt });

  if (response.statusCode < 200 || response.statusCode >= 300) {
    const detail = response.rawText ? `: ${response.rawText.slice(0, 400)}` : '.';
    throw new Error(`llama.cpp ${stage} request failed with HTTP ${response.statusCode}${detail}`);
  }

  const firstChoice = (response.body?.choices?.[0] || {}) as Record<string, unknown>;
  const { text: rawChoiceText, thinkingText } = extractChoiceContent(firstChoice);
  const synthesized = actionFromToolCall(firstChoice, allowedToolNames);
  const promptUsage = getPromptUsageFromResponseBody(response.body);
  const completionUsage = getCompletionUsageFromResponseBody(response.body);
  // Prefer raw content text (may include reasoning field); fall back to synthesized tool-call action
  const text = rawChoiceText || synthesized || '';

  return {
    text: (text || '').trim(),
    thinkingText,
    mockExhausted: false,
    promptTokens: promptUsage.promptTokens,
    completionTokens: completionUsage.completionTokens,
    usageThinkingTokens: completionUsage.thinkingTokens,
    promptCacheTokens: promptUsage.promptCacheTokens,
    promptEvalTokens: promptUsage.promptEvalTokens,
    promptEvalDurationMs: null,
    generationDurationMs: null,
  };
}

// ---------------------------------------------------------------------------
// SSE streaming implementation (internal)
// ---------------------------------------------------------------------------

function requestStreaming(
  options: PlannerRequestOptions,
  bodyJson: string,
  stage: string,
): Promise<PlannerActionResponse> {
  const toolDefinitions = Array.isArray(options.toolDefinitions) && options.toolDefinitions.length > 0
    ? options.toolDefinitions
    : TOOL_DEFINITIONS;
  const allowedToolNames = new Set<string>(toolDefinitions.map((toolDefinition) => toolDefinition.function.name));
  const target = new URL(`${options.baseUrl.replace(/\/$/u, '')}/v1/chat/completions`);
  const transport = target.protocol === 'https:' ? https : http;

  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const method = 'POST';
    const urlPath = `${target.pathname}${target.search}`;

    options.logger?.write({ kind: 'provider_request_start', stage, method, url: target.toString(), path: urlPath });

    let settled = false;
    const request = transport.request({
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port || (target.protocol === 'https:' ? 443 : 80),
      path: urlPath,
      method,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(bodyJson, 'utf8') },
    }, (response) => {
      if ((response.statusCode || 0) >= 400) {
        let body = '';
        response.setEncoding('utf8');
        response.on('data', (chunk: string) => { body += chunk; });
        response.on('end', () => {
          if (!settled) {
            settled = true;
            if (isTransientProviderHttpResponse(response.statusCode || 0, body)) {
              reject(buildTransientProviderHttpError(response.statusCode || 0, body));
              return;
            }
            const serialized = serializeNetworkError(new Error(`llama.cpp ${stage} stream failed with HTTP ${response.statusCode}${body.trim() ? `: ${body.trim().slice(0, 400)}` : '.'}`));
            options.logger?.write({ kind: 'provider_request_error', stage, method, url: target.toString(), path: urlPath, elapsedMs: Date.now() - startedAt, error: serialized });
            reject(new Error(buildProviderErrorMessage({ stage, method, url: target.toString() }, serialized)));
          }
        });
        return;
      }

      let rawBuffer = '';
      let contentText = '';
      let thinkingText = '';
      const toolCalls: Array<{ name: string; arguments: string }> = [];
      let promptTokens: number | null = null;
      let completionTokens: number | null = null;
      let usageThinkingTokens: number | null = null;
      let promptCacheTokens: number | null = null;
      let promptEvalTokens: number | null = null;
      let generationStartedAt: number | null = null;

      response.setEncoding('utf8');
      response.on('data', (chunk: string) => {
        rawBuffer += chunk;
        let boundary = rawBuffer.indexOf('\n\n');
        while (boundary >= 0) {
          const packet = rawBuffer.slice(0, boundary);
          rawBuffer = rawBuffer.slice(boundary + 2);
          boundary = rawBuffer.indexOf('\n\n');
          const lines = packet.split(/\r?\n/gu).map((l) => l.trim()).filter(Boolean);
          const dataLine = lines.find((l) => l.startsWith('data:'));
          if (!dataLine) continue;
          const dataValue = dataLine.slice(5).trim();
          if (dataValue === '[DONE]') continue;
          try {
            const parsed = JSON.parse(dataValue) as Record<string, unknown>;
            const parsedUsage = getPromptUsageFromResponseBody(parsed);
            const parsedCompletionUsage = getCompletionUsageFromResponseBody(parsed);
            if (parsedUsage.promptTokens !== null) promptTokens = parsedUsage.promptTokens;
            if (parsedUsage.promptCacheTokens !== null) promptCacheTokens = parsedUsage.promptCacheTokens;
            if (parsedUsage.promptEvalTokens !== null) promptEvalTokens = parsedUsage.promptEvalTokens;
            if (parsedCompletionUsage.completionTokens !== null) completionTokens = parsedCompletionUsage.completionTokens;
            if (parsedCompletionUsage.thinkingTokens !== null) usageThinkingTokens = parsedCompletionUsage.thinkingTokens;
            const choices = parsed?.choices as Array<Record<string, unknown>> | undefined;
            const choice = Array.isArray(choices) ? choices[0] : null;
            const delta = choice?.delta && typeof choice.delta === 'object' ? choice.delta as Record<string, unknown> : {};
            const message = choice?.message && typeof choice.message === 'object' ? choice.message as Record<string, unknown> : {};
            const deltaThinking = typeof delta.reasoning_content === 'string' ? delta.reasoning_content
              : typeof message.reasoning_content === 'string' ? message.reasoning_content : '';
            const deltaContent = typeof delta.content === 'string' ? delta.content : '';
            if (delta.tool_calls && Array.isArray(delta.tool_calls)) {
              if (generationStartedAt === null) {
                generationStartedAt = Date.now();
              }
              for (const tc of delta.tool_calls as Array<{ index?: number; function?: { name?: string; arguments?: string } }>) {
                const idx = tc.index ?? 0;
                if (!toolCalls[idx]) toolCalls[idx] = { name: '', arguments: '' };
                if (tc.function?.name) toolCalls[idx].name += tc.function.name;
                if (tc.function?.arguments) toolCalls[idx].arguments += tc.function.arguments;
              }
            }
            if (deltaThinking) {
              if (generationStartedAt === null) {
                generationStartedAt = Date.now();
              }
              thinkingText += deltaThinking;
              options.onThinkingDelta?.(thinkingText);
            }
            if (deltaContent) {
              if (generationStartedAt === null) {
                generationStartedAt = Date.now();
              }
              contentText += deltaContent;
              options.onContentDelta?.(contentText);
            }
          } catch { /* ignore malformed chunks */ }
        }
      });

      response.on('end', () => {
        if (settled) return;
        settled = true;
        options.logger?.write({ kind: 'provider_request_done', stage, method, url: target.toString(), path: urlPath, statusCode: response.statusCode || 0, elapsedMs: Date.now() - startedAt });
        let synthesized: string | null = null;
        const parsedToolCalls = toolCalls
          .map((toolCall) => parseRepoToolCallCandidate({
            function: {
              name: toolCall?.name,
              arguments: toolCall?.arguments,
            },
          }, allowedToolNames))
          .filter(Boolean) as ToolAction[];
        if (parsedToolCalls.length === 1) {
          synthesized = JSON.stringify(parsedToolCalls[0]);
        } else if (parsedToolCalls.length > 1) {
          synthesized = JSON.stringify({
            action: 'tool_batch',
            tool_calls: parsedToolCalls.map((toolCall) => ({
              tool_name: toolCall.tool_name,
              args: toolCall.args,
            })),
          });
        }
        // If reasoning_content didn't give us thinking, try to extract <think>...</think> from content
        let finalThinkingText = thinkingText.trim();
        let finalContentText = contentText.trim();
        if (!finalThinkingText && finalContentText.includes('<think>')) {
          const extracted = extractInlineThinking(finalContentText);
          finalThinkingText = extracted.thinkingText;
          finalContentText = extracted.text;
        }
        const text = finalContentText || synthesized || '';
        const finishedAt = Date.now();
        resolve({
          text: typeof text === 'string' ? text.trim() : text,
          thinkingText: finalThinkingText,
          mockExhausted: false,
          promptTokens,
          completionTokens,
          usageThinkingTokens,
          promptCacheTokens,
          promptEvalTokens,
          promptEvalDurationMs: generationStartedAt === null ? null : Math.max(generationStartedAt - startedAt, 0),
          generationDurationMs: generationStartedAt === null ? null : Math.max(finishedAt - generationStartedAt, 0),
        });
      });
    });

    request.on('error', (err) => {
      if (!settled) {
        settled = true;
        const serialized = serializeNetworkError(err);
        options.logger?.write({ kind: 'provider_request_error', stage, method, url: target.toString(), path: urlPath, elapsedMs: Date.now() - startedAt, error: serialized });
        reject(new Error(buildProviderErrorMessage({ stage, method, url: target.toString() }, serialized)));
      }
    });

    request.setTimeout(options.timeoutMs, () => {
      request.destroy(new Error(`Request timed out after ${options.timeoutMs} ms.`));
    });

    request.write(bodyJson);
    request.end();
  });
}

// ---------------------------------------------------------------------------
// Finish validation
// ---------------------------------------------------------------------------

export async function requestFinishValidation(options: {
  baseUrl: string;
  model: string;
  prompt: string;
  timeoutMs: number;
  requestMaxTokens: number;
  thinkingEnabled?: boolean;
  reasoningContentEnabled?: boolean;
  preserveThinking?: boolean;
  mockResponses?: string[];
  mockResponseIndex?: number;
  logger?: JsonLogger | null;
}): Promise<PlannerActionResponse> {
  return requestPlannerAction({
    baseUrl: options.baseUrl,
    model: options.model,
    messages: [{ role: 'user', content: options.prompt }],
    timeoutMs: options.timeoutMs,
    requestMaxTokens: options.requestMaxTokens,
    thinkingEnabled: options.thinkingEnabled,
    reasoningContentEnabled: options.reasoningContentEnabled,
    preserveThinking: options.preserveThinking,
    mockResponses: options.mockResponses,
    mockResponseIndex: options.mockResponseIndex,
    logger: options.logger,
    stage: 'finish_validation',
    responseSchema: buildFinishValidationJsonSchema(),
    responseSchemaName: 'siftkit_finish_validation',
    toolDefinitions: [],
  });
}

export function parseFinishValidationResponse(text: string): FinishValidationResult {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(stripCodeFence(text)) as Record<string, unknown>;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Provider returned an invalid finish validation payload: ${message}`);
  }
  const verdict = typeof parsed.verdict === 'string' ? parsed.verdict.trim().toLowerCase() : '';
  if (verdict !== 'pass' && verdict !== 'fail') {
    throw new Error('Provider returned an invalid finish validation payload.');
  }
  if (typeof parsed.reason !== 'string' || !parsed.reason.trim()) {
    throw new Error('Provider returned an invalid finish validation payload.');
  }
  return { verdict: verdict as 'pass' | 'fail', reason: parsed.reason.trim() };
}

// ---------------------------------------------------------------------------
// Terminal synthesis
// ---------------------------------------------------------------------------

export async function requestTerminalSynthesis(options: {
  baseUrl: string;
  model: string;
  prompt: string;
  timeoutMs: number;
  requestMaxTokens: number;
  thinkingEnabled?: boolean;
  reasoningContentEnabled?: boolean;
  preserveThinking?: boolean;
  mockResponses?: string[];
  mockResponseIndex?: number;
  logger?: JsonLogger | null;
}): Promise<PlannerActionResponse> {
  return requestPlannerAction({
    baseUrl: options.baseUrl,
    model: options.model,
    messages: [{ role: 'user', content: options.prompt }],
    timeoutMs: options.timeoutMs,
    requestMaxTokens: options.requestMaxTokens,
    thinkingEnabled: options.thinkingEnabled,
    reasoningContentEnabled: options.reasoningContentEnabled,
    preserveThinking: options.preserveThinking,
    mockResponses: options.mockResponses,
    mockResponseIndex: options.mockResponseIndex,
    logger: options.logger,
    stage: 'terminal_synthesis',
    responseSchema: null,
    toolDefinitions: [],
  });
}

// Re-export from shared helpers for convenience.
export { isTransientProviderError } from '../lib/provider-helpers.js';

// ---------------------------------------------------------------------------
// Message rendering
// ---------------------------------------------------------------------------

export function renderTaskTranscript(messages: ChatMessage[]): string {
  return messages.map((message) => {
    const sections = [`[${String(message.role || 'unknown')}]`];
    if (typeof message.content === 'string' && message.content) {
      sections.push(message.content);
    }
    if (Array.isArray(message.tool_calls)) {
      for (const toolCall of message.tool_calls) {
        sections.push(JSON.stringify({
          id: toolCall.id || null,
          type: toolCall.type || 'function',
          function: { name: toolCall.function?.name || '', arguments: toolCall.function?.arguments || {} },
        }));
      }
    }
    if (typeof message.tool_call_id === 'string' && message.tool_call_id) {
      sections.push(`tool_call_id=${message.tool_call_id}`);
    }
    return sections.join('\n');
  }).join('\n\n');
}

export function buildRepoSearchAssistantToolMessage(command: string, toolCallId: string, toolName?: string): ChatMessage {
  const resolvedToolName = String(toolName || '').trim().toLowerCase()
    || getRepoSearchToolNameForCommand(command);
  if (!resolvedToolName || !isRepoSearchCommandToolName(resolvedToolName)) {
    throw new Error(`Cannot derive repo-search tool name from command: ${command}`);
  }
  return {
    role: 'assistant',
    content: '',
    tool_calls: [{
      id: toolCallId,
      type: 'function',
      function: { name: resolvedToolName, arguments: JSON.stringify({ command }) },
    }],
  };
}

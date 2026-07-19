import type { InferenceBackendId, SiftConfig } from '../config/types.js';
import { getDefaultConfigObject } from '../config/defaults.js';
import { LlamaCppClient } from '../llm-protocol/llama-cpp-client.js';
import type { JsonObject, LlamaCppChatMessage, LlamaCppChatRole, LlamaCppToolCall } from '../llm-protocol/types.js';
import { ModelJson } from '../lib/model-json.js';
import { toError } from '../lib/errors.js';
import {
  buildProviderErrorMessage,
  retryProviderRequest,
  serializeNetworkError,
} from '../lib/provider-helpers.js';
import {
  buildFinishValidationJsonSchema,
  buildLlamaJsonSchemaResponseFormat,
  buildRepoSearchPlannerActionJsonSchema,
  type StructuredOutputToolDefinition,
} from '../providers/structured-output-schema.js';
import {
  getFirstCommandToken,
  REPO_SEARCH_PIPE_COMMANDS,
  REPO_SEARCH_PRODUCER_COMMANDS,
} from './command-safety.js';
import type { JsonLogger } from './types.js';

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
  args: JsonObject;
};

export type ToolBatchAction = {
  action: 'tool_batch';
  tool_calls: Array<{
    tool_name: string;
    args: JsonObject;
  }>;
};

export type FinishAction = {
  action: 'finish';
  output: string;
};

export type PlannerAction = ToolAction | ToolBatchAction | FinishAction;

export type FinishValidationResult = {
  verdict: 'pass' | 'fail';
  reason: string;
};

export type ChatMessage = {
  role: LlamaCppChatRole;
  content?: string;
  reasoning_content?: string;
  tool_calls?: Array<{
    id: string;
    type: string;
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
};

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
  web_search: {
    type: 'function',
    function: {
      name: 'web_search',
      description: 'Search the public web and return concise result titles, URLs, and snippets. Use only when external/current information is needed.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          timeFilter: { type: 'string', enum: ['day', 'week', 'month', 'year'] },
        },
        required: ['query'],
      },
    },
  },
  web_fetch: {
    type: 'function',
    function: {
      name: 'web_fetch',
      description: 'Fetch one public HTTP(S) URL and return extracted text. Private, local, and internal URLs are blocked.',
      parameters: {
        type: 'object',
        properties: { url: { type: 'string' } },
        required: ['url'],
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
  REPO_SEARCH_COMMAND_TOKENS.map((commandToken): [string, StructuredOutputToolDefinition] => {
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
);

const REPO_SEARCH_TOOL_REGISTRY: Record<string, StructuredOutputToolDefinition> = {
  ...NATIVE_REPO_SEARCH_TOOL_REGISTRY,
  ...COMMAND_REPO_SEARCH_TOOL_REGISTRY,
};

const WEB_NATIVE_TOOL_NAMES = new Set<string>(['web_search', 'web_fetch']);
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
    ...Object.keys(REPO_SEARCH_TOOL_REGISTRY).filter((toolName) => !WEB_NATIVE_TOOL_NAMES.has(toolName)),
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
  if (!Array.isArray(allowedToolNames)) return Object.values(REPO_SEARCH_TOOL_REGISTRY);
  return allowedToolNames
    .map((toolName) => REPO_SEARCH_TOOL_REGISTRY[String(toolName || '').trim().toLowerCase()])
    .filter((toolDefinition): toolDefinition is StructuredOutputToolDefinition => Boolean(toolDefinition));
}

export const TOOL_DEFINITIONS = resolveRepoSearchPlannerToolDefinitions();

export function buildPlannerRequestPromptReserveText(options: {
  stage?: string;
  model: string;
  messageRoles: readonly string[];
  toolDefinitions?: StructuredOutputToolDefinition[];
  maxTokens: number;
  thinkingEnabled: boolean;
  reasoningContentEnabled: boolean;
  preserveThinking: boolean;
  responseSchema?: JsonObject | null;
  responseSchemaName?: string;
  extraBody?: JsonObject;
  stream?: boolean;
}): string {
  const stage = options.stage || 'planner_action';
  const toolDefinitions = Array.isArray(options.toolDefinitions) ? options.toolDefinitions : TOOL_DEFINITIONS;
  const defaultResponseSchema = stage === 'planner_action'
    ? buildRepoSearchPlannerActionJsonSchema({ toolDefinitions })
    : stage === 'finish_validation'
      ? buildFinishValidationJsonSchema()
      : null;
  const responseSchema = options.responseSchema === undefined ? defaultResponseSchema : options.responseSchema;
  const responseFormat = responseSchema === null ? null : buildLlamaJsonSchemaResponseFormat({
    name: options.responseSchemaName || (stage === 'finish_validation' ? 'siftkit_finish_validation' : 'siftkit_repo_search_planner_action'),
    schema: responseSchema,
  });

  return JSON.stringify({
    stage,
    model: options.model,
    max_tokens: options.maxTokens,
    chat_template_kwargs: {
      enable_thinking: Boolean(options.thinkingEnabled),
      ...(options.thinkingEnabled && options.reasoningContentEnabled ? { reasoning_content: true } : {}),
      ...(options.thinkingEnabled && options.reasoningContentEnabled && options.preserveThinking ? { preserve_thinking: true } : {}),
    },
    ...(responseFormat ? { response_format: responseFormat } : {}),
    ...(options.stream ? { stream: true } : {}),
    message_template_reserve: options.messageRoles.map((role) => ({
      role: String(role || 'unknown'),
      template: '<|im_start|>role\\ncontent<|im_end|>',
    })),
    ...options.extraBody,
  });
}

export type PlannerRequestOptions = {
  backend?: InferenceBackendId;
  baseUrl: string;
  model: string;
  messages: ChatMessage[];
  slotId?: number;
  timeoutMs: number;
  maxTokens: number;
  thinkingEnabled?: boolean;
  reasoningContentEnabled?: boolean;
  preserveThinking?: boolean;
  stream?: boolean;
  onThinkingDelta?: (accumulatedThinking: string) => void;
  onContentDelta?: (accumulatedContent: string) => void;
  mockResponses?: string[];
  mockResponseIndex?: number;
  abortSignal?: AbortSignal;
  logger?: JsonLogger | null;
  stage?: string;
  responseSchema?: JsonObject | null;
  responseSchemaName?: string;
  toolDefinitions?: StructuredOutputToolDefinition[];
  extraBody?: JsonObject;
};

function extractInlineThinking(raw: string): { thinkingText: string; text: string } {
  const thinkingParts: string[] = [];
  const text = raw.replace(/<think>([\s\S]*?)<\/think>/gu, (_all, thinking: string) => {
    thinkingParts.push(thinking);
    return '';
  }).trim();
  return { thinkingText: thinkingParts.join('\n').trim(), text };
}

function toLlamaChatRole(role: string): LlamaCppChatRole {
  return role === 'system' || role === 'user' || role === 'assistant' || role === 'tool' ? role : 'user';
}

export function toProtocolChatMessages(messages: readonly ChatMessage[]): LlamaCppChatMessage[] {
  return messages.map((message) => ({
    role: toLlamaChatRole(message.role),
    content: message.content ?? null,
    ...(message.reasoning_content === undefined ? {} : { reasoning_content: message.reasoning_content }),
    ...(message.tool_call_id === undefined ? {} : { tool_call_id: message.tool_call_id }),
    ...(message.tool_calls === undefined ? {} : {
      tool_calls: message.tool_calls.map((toolCall): LlamaCppToolCall => ({
        id: toolCall.id,
        type: 'function',
        function: { name: toolCall.function.name, arguments: toolCall.function.arguments },
      })),
    }),
  }));
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
  if (!Object.prototype.hasOwnProperty.call(message, 'reasoning_content')) return message;
  const { reasoning_content: _reasoningContent, ...rest } = message;
  return rest;
}

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

function buildPlannerRequestConfig(options: PlannerRequestOptions): SiftConfig {
  const reasoning = options.thinkingEnabled ? 'on' : 'off';
  const base = getDefaultConfigObject();
  const defaultPreset = base.Server.ModelPresets.Presets[0];
  if (!defaultPreset) throw new Error('Default model preset is missing.');
  return {
    ...base,
    Backend: 'llama.cpp',
    Runtime: {
      ...base.Runtime,
      LlamaCpp: {
        ...base.Runtime.LlamaCpp,
        BaseUrl: options.baseUrl,
        Reasoning: reasoning,
      },
    },
    Server: {
      ...base.Server,
      ModelPresets: {
        ...base.Server.ModelPresets,
        ActivePresetId: 'planner',
        Presets: [{
          ...defaultPreset,
          id: 'planner',
          label: 'planner',
          Model: options.model,
          BaseUrl: options.baseUrl,
          Reasoning: reasoning,
          ReasoningContent: options.reasoningContentEnabled === true,
          PreserveThinking: options.preserveThinking === true,
        }],
      },
    },
  };
}

function actionFromProtocolToolCalls(toolCalls: readonly LlamaCppToolCall[], allowedToolNames: readonly string[]): string | null {
  const parsedToolCalls = toolCalls
    .map((toolCall): ToolAction | null => {
      const args = ModelJson.parseToolArguments(toolCall.function.arguments);
      if (!args) return null;
      try {
        const action = ModelJson.parseRepoSearchPlannerAction(JSON.stringify({
          action: toolCall.function.name,
          ...args,
        }), { allowedToolNames });
        return action.action === 'tool' ? action : null;
      } catch {
        return null;
      }
    })
    .filter((toolCall): toolCall is ToolAction => toolCall !== null);
  if (parsedToolCalls.length === 0) return null;
  if (parsedToolCalls.length === 1) return JSON.stringify(parsedToolCalls[0]);
  return JSON.stringify({
    action: 'tool_batch',
    calls: parsedToolCalls.map((toolCall) => ({
      action: toolCall.tool_name,
      ...toolCall.args,
    })),
  });
}

export async function requestRepoSearchPlannerProtocolAction(options: PlannerRequestOptions): Promise<PlannerActionResponse> {
  if (options.abortSignal?.aborted) {
    throw options.abortSignal.reason instanceof Error
      ? options.abortSignal.reason
      : new Error(String(options.abortSignal.reason || 'Request aborted.'));
  }

  if (Array.isArray(options.mockResponses)) {
    const index = options.mockResponseIndex || 0;
    if (index >= options.mockResponses.length) return { text: '', thinkingText: '', mockExhausted: true };
    const rawMock = options.mockResponses[index];
    const { thinkingText, text } = rawMock.includes('<think>')
      ? extractInlineThinking(rawMock)
      : { thinkingText: '', text: rawMock };
    return { text, thinkingText, mockExhausted: false, nextMockResponseIndex: index + 1 };
  }

  const stage = options.stage || 'planner_action';
  const toolDefinitions = Array.isArray(options.toolDefinitions) ? options.toolDefinitions : TOOL_DEFINITIONS;
  const allowedToolNames = toolDefinitions.map((toolDefinition) => toolDefinition.function.name);
  const defaultResponseSchema = stage === 'planner_action'
    ? buildRepoSearchPlannerActionJsonSchema({ toolDefinitions })
    : stage === 'finish_validation'
      ? buildFinishValidationJsonSchema()
      : null;
  const responseSchema = options.responseSchema === undefined ? defaultResponseSchema : options.responseSchema;
  const responseFormat = responseSchema === null ? null : buildLlamaJsonSchemaResponseFormat({
    name: options.responseSchemaName || (stage === 'finish_validation' ? 'siftkit_finish_validation' : 'siftkit_repo_search_planner_action'),
    schema: responseSchema,
  });
  const requestUrlForLog = `${options.baseUrl.replace(/\/$/u, '')}/v1` + '/chat/completions';
  const requestPathForLog = new URL(requestUrlForLog).pathname;
  const startedAt = Date.now();
  options.logger?.write({ kind: 'provider_request_start', stage, method: 'POST', url: requestUrlForLog, path: requestPathForLog });

  let response;
  try {
    response = await retryProviderRequest(
      () => new LlamaCppClient().chat({
        backend: options.backend,
        config: buildPlannerRequestConfig(options),
        baseUrl: options.baseUrl,
        model: options.model,
        messages: toProtocolChatMessages(options.messages.map((message) => serializePlannerMessage(message, options.reasoningContentEnabled === true))),
        tools: [],
        maxTokens: options.maxTokens,
        temperature: 0.1,
        slotId: options.slotId,
        stream: options.stream === true,
        responseFormat: responseFormat ?? undefined,
        reasoningOverride: options.thinkingEnabled ? 'on' : 'off',
        allowedToolNames,
        requestTimeoutSeconds: options.timeoutMs / 1000,
        retryMaxWaitMs: 0,
        abortSignal: options.abortSignal,
        extraBody: { top_p: 0.95, ...(options.extraBody || {}) },
        onThinkingDelta: options.onThinkingDelta,
        onContentDelta: options.onContentDelta,
      }),
      {
        maxWaitMs: options.timeoutMs,
        onRetry(event) {
          logProviderRetry({
            logger: options.logger,
            stage,
            method: 'POST',
            url: requestUrlForLog,
            path: requestPathForLog,
            attempt: event.attempt,
            elapsedMs: event.elapsedMs,
            nextDelayMs: event.nextDelayMs,
            error: event.error,
          });
        },
      },
    );
  } catch (error) {
    const serialized = serializeNetworkError(toError(error));
    options.logger?.write({
      kind: 'provider_request_error',
      stage,
      method: 'POST',
      url: requestUrlForLog,
      path: requestPathForLog,
      elapsedMs: Date.now() - startedAt,
      error: serialized,
    });
    throw new Error(buildProviderErrorMessage({ stage, method: 'POST', url: requestUrlForLog }, serialized));
  }
  options.logger?.write({
    kind: 'provider_request_done',
    stage,
    method: 'POST',
    url: requestUrlForLog,
    path: requestPathForLog,
    statusCode: 200,
    elapsedMs: Date.now() - startedAt,
    ...(response.earlyStopReason ? { earlyTerminationReason: response.earlyStopReason } : {}),
  });

  const inlineThinking = !response.reasoningText && response.text.includes('<think>')
    ? extractInlineThinking(response.text)
    : null;
  const rawChoiceText = inlineThinking ? inlineThinking.text : response.text;
  const thinkingText = inlineThinking ? inlineThinking.thinkingText : response.reasoningText;
  const synthesized = actionFromProtocolToolCalls(response.toolCalls, allowedToolNames);
  const text = response.earlyStopReason === 'planner action completed in streamed reasoning'
    ? rawChoiceText
    : response.stoppedEarly && response.earlyStopReason
    ? [`SiftKit stopped the planner stream early: ${response.earlyStopReason}.`, rawChoiceText.trim()].filter(Boolean).join('\n')
    : rawChoiceText || synthesized || '';

  return {
    text: text.trim(),
    thinkingText,
    mockExhausted: false,
    promptTokens: response.usage.promptTokens,
    completionTokens: response.usage.completionTokens,
    usageThinkingTokens: response.usage.thinkingTokens,
    promptCacheTokens: response.usage.promptCacheTokens,
    promptEvalTokens: response.usage.promptEvalTokens,
    promptEvalDurationMs: response.usage.promptEvalDurationMs ?? null,
    generationDurationMs: response.usage.generationDurationMs ?? null,
  };
}

export async function requestFinishValidation(options: {
  backend?: InferenceBackendId;
  baseUrl: string;
  model: string;
  prompt: string;
  timeoutMs: number;
  maxTokens: number;
  thinkingEnabled?: boolean;
  reasoningContentEnabled?: boolean;
  preserveThinking?: boolean;
  mockResponses?: string[];
  mockResponseIndex?: number;
  logger?: JsonLogger | null;
}): Promise<PlannerActionResponse> {
  return requestRepoSearchPlannerProtocolAction({
    backend: options.backend,
    baseUrl: options.baseUrl,
    model: options.model,
    messages: [{ role: 'user', content: options.prompt }],
    timeoutMs: options.timeoutMs,
    maxTokens: options.maxTokens,
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

export async function requestTerminalSynthesis(options: {
  backend?: InferenceBackendId;
  baseUrl: string;
  model: string;
  prompt: string;
  timeoutMs: number;
  maxTokens: number;
  thinkingEnabled?: boolean;
  reasoningContentEnabled?: boolean;
  preserveThinking?: boolean;
  mockResponses?: string[];
  mockResponseIndex?: number;
  logger?: JsonLogger | null;
  stream?: boolean;
  onContentDelta?: (accumulatedContent: string) => void;
}): Promise<PlannerActionResponse> {
  return requestRepoSearchPlannerProtocolAction({
    backend: options.backend,
    baseUrl: options.baseUrl,
    model: options.model,
    messages: [{ role: 'user', content: options.prompt }],
    timeoutMs: options.timeoutMs,
    maxTokens: options.maxTokens,
    thinkingEnabled: options.thinkingEnabled,
    reasoningContentEnabled: options.reasoningContentEnabled,
    preserveThinking: options.preserveThinking,
    mockResponses: options.mockResponses,
    mockResponseIndex: options.mockResponseIndex,
    logger: options.logger,
    stage: 'terminal_synthesis',
    responseSchema: null,
    toolDefinitions: [],
    stream: options.stream,
    onContentDelta: options.onContentDelta,
  });
}

export { isTransientProviderError } from '../lib/provider-helpers.js';

export function renderTaskTranscript(messages: ChatMessage[]): string {
  return messages.map((message) => {
    const sections = [`[${String(message.role || 'unknown')}]`];
    if (typeof message.content === 'string' && message.content) sections.push(message.content);
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
  const resolvedToolName = String(toolName || '').trim().toLowerCase() || getRepoSearchToolNameForCommand(command);
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

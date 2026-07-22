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
import { lowerResponseFormatForBackend } from '../providers/formatron-schema-lowering.js';
import { getFirstCommandToken } from './command-safety.js';
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
  speculativeAcceptedTokens?: number | null;
  speculativeGeneratedTokens?: number | null;
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

// The tool surface mirrors pi.dev: read, write, edit, run, grep, find, ls — plus `git` (the only
// command-string tool) and the two web tools. `write`, `edit` and `run` are implemented and tested
// in engine/repo-tools.ts but deliberately absent from EXPOSED_REPO_TOOL_NAMES, so they never reach
// a model. See docs/plan-pi-tool-surface.md.
const REPO_TOOL_REGISTRY: Record<string, StructuredOutputToolDefinition> = {
  read: {
    type: 'function',
    function: {
      name: 'read',
      description: 'Read the contents of a repository file. Lines are returned numbered. Use offset/limit for large files; when you need the full file, continue with offset until complete. Lines already returned in this task are skipped automatically.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Path to the file to read, relative to the repository root' },
          offset: { type: 'integer', description: 'Line number to start reading from (1-indexed)' },
          limit: { type: 'integer', description: 'Maximum number of lines to read' },
        },
        required: ['path'],
      },
    },
  },
  grep: {
    type: 'function',
    function: {
      name: 'grep',
      description: 'Search file contents for a pattern. Returns matching lines with file paths and line numbers. Ignored paths are excluded automatically. Output is capped at limit matches (default 100).',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Search pattern (regex, or literal string when literal=true)' },
          path: { type: 'string', description: 'Directory or file to search (default: repository root)' },
          glob: { type: 'string', description: "Filter files by glob pattern, e.g. '*.ts' or 'src/**/*.test.ts'" },
          ignoreCase: { type: 'boolean', description: 'Case-insensitive search (default: true)' },
          literal: { type: 'boolean', description: 'Treat pattern as a literal string instead of a regex (default: false)' },
          context: { type: 'integer', description: 'Number of lines to show before and after each match (default: 0)' },
          limit: { type: 'integer', description: 'Maximum number of matches to return (default: 100)' },
        },
        required: ['pattern'],
      },
    },
  },
  find: {
    type: 'function',
    function: {
      name: 'find',
      description: 'Find files by glob pattern. Returns matching paths relative to the search directory. Ignored paths are excluded automatically. Output is capped at limit results (default 1000).',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: "Glob pattern to match files, e.g. '*.ts', '**/*.json', or 'src/**/*.test.ts'" },
          path: { type: 'string', description: 'Directory to search in (default: repository root)' },
          limit: { type: 'integer', description: 'Maximum number of results (default: 1000)' },
        },
        required: ['pattern'],
      },
    },
  },
  ls: {
    type: 'function',
    function: {
      name: 'ls',
      description: "List directory contents one level deep. Entries are sorted alphabetically with a '/' suffix on directories, dotfiles included. Output is capped at limit entries (default 500).",
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Directory to list (default: repository root)' },
          limit: { type: 'integer', description: 'Maximum number of entries to return (default: 500)' },
        },
        required: [],
      },
    },
  },
  write: {
    type: 'function',
    function: {
      name: 'write',
      description: "Write content to a file. Creates the file if it doesn't exist, overwrites if it does. Automatically creates parent directories.",
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Path to the file to write, relative to the repository root' },
          content: { type: 'string', description: 'Content to write to the file' },
        },
        required: ['path', 'content'],
      },
    },
  },
  edit: {
    type: 'function',
    function: {
      name: 'edit',
      description: 'Edit a single file using exact text replacement. Every edits[].oldText must match a unique, non-overlapping region of the original file. If two changes affect the same block or nearby lines, merge them into one edit instead of emitting overlapping edits.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Path to the file to edit, relative to the repository root' },
          edits: {
            type: 'array',
            description: 'One or more targeted replacements. Each edit is matched against the original file, not incrementally.',
            items: {
              type: 'object',
              properties: {
                oldText: { type: 'string', description: 'Exact text for one targeted replacement. Must be unique in the original file and must not overlap any other edits[].oldText in the same call.' },
                newText: { type: 'string', description: 'Replacement text for this targeted edit.' },
              },
              required: ['oldText', 'newText'],
            },
          },
        },
        required: ['path', 'edits'],
      },
    },
  },
  run: {
    type: 'function',
    function: {
      name: 'run',
      description: 'Execute a shell command in the repository root. Returns stdout and stderr.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'Command to execute' },
          timeout: { type: 'integer', description: 'Timeout in seconds (optional, no default timeout)' },
        },
        required: ['command'],
      },
    },
  },
  git: {
    type: 'function',
    function: {
      name: 'git',
      description: "Run one read-only git command in the repository, e.g. 'git status --short', 'git log -n 20 --oneline', 'git show <ref>:<path>', 'git blame -L 40,80 <path>'. History and working-tree inspection only; commands that mutate the repository are rejected.",
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: "The full git command line, starting with 'git'" },
        },
        required: ['command'],
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

/** Tools a model may be offered. `write`, `edit` and `run` are implemented but withheld. */
export const EXPOSED_REPO_TOOL_NAMES = ['read', 'grep', 'find', 'ls', 'git', 'web_search', 'web_fetch'] as const;

/** `git` is the only tool whose args carry a raw command string; everything else is native. */
export const REPO_COMMAND_TOOL_NAME = 'git';

const EXPOSED_REPO_TOOL_NAME_SET = new Set<string>(EXPOSED_REPO_TOOL_NAMES);
const WEB_TOOL_NAMES = new Set<string>(['web_search', 'web_fetch']);

function normalizeToolName(toolName: string): string {
  return String(toolName || '').trim().toLowerCase();
}

export function getRepoSearchToolNames(): string[] {
  return [...EXPOSED_REPO_TOOL_NAMES];
}

export function getRepoSearchToolNamesForParsing(): string[] {
  return EXPOSED_REPO_TOOL_NAMES.filter((toolName) => !WEB_TOOL_NAMES.has(toolName));
}

export function isRepoSearchCommandToolName(toolName: string): boolean {
  return normalizeToolName(toolName) === REPO_COMMAND_TOOL_NAME;
}

export function isRepoSearchNativeToolName(toolName: string): boolean {
  const normalized = normalizeToolName(toolName);
  return EXPOSED_REPO_TOOL_NAME_SET.has(normalized) && normalized !== REPO_COMMAND_TOOL_NAME;
}

export function getRepoSearchCommandTokenForToolName(toolName: string): string | null {
  return isRepoSearchCommandToolName(toolName) ? REPO_COMMAND_TOOL_NAME : null;
}

export function getRepoSearchToolNameForCommand(command: string): string | null {
  return getFirstCommandToken(String(command || '').trim()) === REPO_COMMAND_TOOL_NAME
    ? REPO_COMMAND_TOOL_NAME
    : null;
}

export function resolveRepoSearchPlannerToolDefinitions(
  allowedToolNames?: readonly string[],
): StructuredOutputToolDefinition[] {
  const requested = Array.isArray(allowedToolNames)
    ? allowedToolNames.map(normalizeToolName)
    : [...EXPOSED_REPO_TOOL_NAMES];
  const seen = new Set<string>();
  const definitions: StructuredOutputToolDefinition[] = [];
  for (const toolName of requested) {
    if (seen.has(toolName) || !EXPOSED_REPO_TOOL_NAME_SET.has(toolName)) {
      continue;
    }
    seen.add(toolName);
    definitions.push(REPO_TOOL_REGISTRY[toolName]);
  }
  return definitions;
}

export const TOOL_DEFINITIONS = resolveRepoSearchPlannerToolDefinitions();

export function buildPlannerRequestPromptReserveText(options: {
  backend: InferenceBackendId;
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
  const responseFormat = responseSchema === null ? null : lowerResponseFormatForBackend(options.backend, buildLlamaJsonSchemaResponseFormat({
    name: options.responseSchemaName || (stage === 'finish_validation' ? 'siftkit_finish_validation' : 'siftkit_repo_search_planner_action'),
    schema: responseSchema,
  }));

  return JSON.stringify({
    stage,
    model: options.model,
    max_tokens: options.maxTokens,
    temperature: 0.1,
    top_p: 0.95,
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
          Backend: options.backend ?? 'llama',
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

function actionFromProtocolToolCalls(
  toolCalls: readonly LlamaCppToolCall[],
  toolDefinitions: readonly StructuredOutputToolDefinition[],
): string | null {
  const allowedToolNames = toolDefinitions.map((toolDefinition) => toolDefinition.function.name);
  const parsedToolCalls = toolCalls
    .map((toolCall): ToolAction | null => {
      const args = ModelJson.parseToolArguments(toolCall.function.arguments);
      if (!args) return null;
      try {
        const action = ModelJson.parseRepoSearchPlannerAction(JSON.stringify({
          action: toolCall.function.name,
          ...args,
        }), { toolDefinitions });
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
        config: buildPlannerRequestConfig(options),
        baseUrl: options.baseUrl,
        model: options.model,
        messages: toProtocolChatMessages(options.messages.map((message) => serializePlannerMessage(message, options.reasoningContentEnabled === true))),
        tools: [],
        maxTokens: options.maxTokens,
        temperature: 0.1,
        topP: 0.95,
        slotId: options.slotId,
        stream: options.stream === true,
        responseFormat: responseFormat ?? undefined,
        reasoningOverride: options.thinkingEnabled ? 'on' : 'off',
        allowedToolNames,
        requestTimeoutSeconds: options.timeoutMs / 1000,
        retryMaxWaitMs: 0,
        abortSignal: options.abortSignal,
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
  const synthesized = actionFromProtocolToolCalls(response.toolCalls, toolDefinitions);
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
    speculativeAcceptedTokens: response.usage.speculativeAcceptedTokens ?? null,
    speculativeGeneratedTokens: response.usage.speculativeGeneratedTokens ?? null,
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

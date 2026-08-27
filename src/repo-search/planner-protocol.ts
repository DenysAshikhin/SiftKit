import type { SiftConfig } from '../config/types.js';
import { getActiveInferenceBackend, getActiveModelPreset } from '../config/index.js';
import { buildPresetRequestDefaults } from '../inference-presets/preset-compatibility.js';
import { clampToPresetMaxTokens } from '../lib/dynamic-output-cap.js';
import { LlamaCppClient } from '../llm-protocol/llama-cpp-client.js';
import { LiveContentClassifier, type LiveContentSnapshot } from '../llm-protocol/live-content-classifier.js';
import type { JsonObject, LlamaCppChatMessage, LlamaCppChatRequest, LlamaCppChatRole, LlamaCppContentPart, LlamaCppToolCall, LlamaCppToolDefinition } from '../llm-protocol/types.js';
import { LlamaCppToolDefinitionsSchema } from '../llm-protocol/types.js';
import { parseJsonValueText } from '../lib/json.js';
import { JsonObjectSchema } from '../lib/json-types.js';
import { extractContentText } from '../llm-protocol/image-attachments.js';
import { toError } from '../lib/errors.js';
import {
  buildProviderErrorMessage,
  retryProviderRequest,
  serializeNetworkError,
} from '../lib/provider-helpers.js';
import {
  buildFinishValidationJsonSchema,
  buildLlamaJsonSchemaResponseFormat,
} from '../providers/structured-output-schema.js';
import { buildApprovalVerdictJsonSchema } from './approval-verdict.js';
import { buildPlannerJsonSchema, type PlannerToolDefinition } from '../planner-protocol/json-schema.js';
import { parseMockPlannerResponse, type MockPlannerResponseInput } from '../planner-protocol/mock-response.js';
import { InferenceRequestBuilder } from '../llm-protocol/inference-request-builder.js';
import { getSupportedImageExtensions } from '../llm-protocol/image-attachments.js';
import { buildInlineThinkPattern, THINK_OPEN_TAG } from '../llm-protocol/think-markers.js';
import type { JsonLogger } from './types.js';
import { REPO_TOOL_ARGUMENT_SCHEMAS, type RepoToolName } from './repo-tool-arguments.js';
import {
  EXPOSED_REPO_TOOL_NAMES,
} from '../planner-protocol/repo-search.js';

export type PlannerActionResponse = {
  text: string;
  thinkingText: string;
  toolCalls: LlamaCppToolCall[];
  mockExhausted: boolean;
  nextMockResponseIndex?: number;
  promptCacheTokens?: number | null;
  promptEvalTokens?: number | null;
  promptEvalDurationMs?: number | null;
  generationDurationMs?: number | null;
  speculativeAcceptedTokens?: number | null;
  speculativeGeneratedTokens?: number | null;
  /** Set when the client stopped thinking at the preset ReasoningBudget and completed via a continuation request. */
  thinkingBudgetExhausted?: true;
};

export type FinishValidationResult = {
  verdict: 'pass' | 'fail';
  reason: string;
};

export type ChatMessage = {
  role: LlamaCppChatRole;
  content?: string | LlamaCppContentPart[];
  /** Internal repository-image identity; omitted by toProtocolChatMessages. */
  imagePathKey?: string;
  reasoning_content?: string;
  tool_calls?: Array<{
    id: string;
    type: string;
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
};

const TEXT_ONLY_READ_DESCRIPTION = 'Read the contents of a repository file. Lines are returned numbered. Use offset/limit for large files; when you need the full file, continue with offset until complete. Lines already returned in this task are skipped automatically, and a read whose whole range was already returned is rejected. Editing or writing a file clears that history, so you can read it again to see your change.';

/**
 * Generated from IMAGE_MIME_MAP rather than hardcoded, so adding a format cannot leave the
 * prompt stale.
 */
function buildVisionReadDescription(textOnlyDescription: string): string {
  const extensions = getSupportedImageExtensions().map((extension) => `\`${extension}\``);
  const formatList = `${extensions.slice(0, -1).join(', ')} or ${extensions[extensions.length - 1]}`;
  return `${textOnlyDescription} Images are supported: reading a ${formatList} file returns the `
    + 'picture itself for you to look at, not its bytes. `offset` and `limit` do not apply to images.';
}

// The tool surface mirrors pi.dev: read, write, edit, run, grep, find, ls — plus typed read-only
// `git` and the two web tools. `write`, `edit` and `run` are implemented and tested
// in engine/repo-tools.ts but deliberately absent from EXPOSED_REPO_TOOL_NAMES, so they never reach
// a model. See docs/plan-pi-tool-surface.md.
function buildRepoToolDefinition(options: {
  toolName: RepoToolName;
  description: string;
  exampleArgs: JsonObject;
}): PlannerToolDefinition {
  const argsSchema = REPO_TOOL_ARGUMENT_SCHEMAS[options.toolName];
  const exampleArgs = JsonObjectSchema.parse(argsSchema.parse(options.exampleArgs));
  return {
    kind: 'tool',
    type: 'function',
    argumentSchema: argsSchema.transform((args) => JsonObjectSchema.parse(args)),
    exampleArgs,
    function: {
      name: options.toolName,
      description: options.description,
      parameters: buildPlannerJsonSchema(argsSchema),
    },
  };
}

const REPO_TOOL_REGISTRY: Record<string, PlannerToolDefinition> = {
  read: buildRepoToolDefinition({
    toolName: 'read',
    description: TEXT_ONLY_READ_DESCRIPTION,
    exampleArgs: { path: 'src/app.ts', offset: 1, limit: 120 },
  }),
  grep: buildRepoToolDefinition({
    toolName: 'grep',
    description: 'Search file contents for a pattern. Returns matching lines with file paths and line numbers. Ignored paths are excluded automatically. Output is capped at limit matches (default 100).',
    exampleArgs: { pattern: 'buildPlanner', path: 'src', glob: '*.ts', context: 2 },
  }),
  find: buildRepoToolDefinition({
    toolName: 'find',
    description: 'Find files by glob pattern. Returns matching paths relative to the search directory. A `**/` segment spans zero or more directories, so `**/name.md` also matches `name.md` sitting directly in the search directory. Ignored paths are excluded automatically. Output is capped at limit results (default 1000).',
    exampleArgs: { pattern: '**/*.test.ts', path: '.' },
  }),
  ls: buildRepoToolDefinition({
    toolName: 'ls',
    description: "List directory contents one level deep. Entries are sorted alphabetically with a '/' suffix on directories, dotfiles included. Output is capped at limit entries (default 500).",
    exampleArgs: { path: 'src' },
  }),
  write: buildRepoToolDefinition({
    toolName: 'write',
    description: "Write content to a file. Creates the file if it doesn't exist, overwrites if it does. Automatically creates parent directories.",
    exampleArgs: { path: 'src/new-file.ts', content: 'export const value = 1;\n' },
  }),
  edit: buildRepoToolDefinition({
    toolName: 'edit',
    description: 'Edit a single file using exact text replacement. Every edits[].oldText must match a unique, non-overlapping region of the original file. If two changes affect the same block or nearby lines, merge them into one edit instead of emitting overlapping edits.',
    exampleArgs: { path: 'src/app.ts', edits: [{ oldText: 'before', newText: 'after' }] },
  }),
  run: buildRepoToolDefinition({
    toolName: 'run',
    description: 'Execute a shell command in the repository root. Returns stdout and stderr.',
    exampleArgs: { command: 'npm test', outputMode: 'auto' },
  }),
  git: buildRepoToolDefinition({
    toolName: 'git',
    description: 'Inspect repository state with one typed read-only operation: status, log, show, diff, blame, grep, or ls_files.',
    exampleArgs: { operation: 'status' },
  }),
  web_search: buildRepoToolDefinition({
    toolName: 'web_search',
    description: 'Search the public web and return concise result titles, URLs, and snippets. Use only when external/current information is needed.',
    exampleArgs: { query: 'current TypeScript documentation' },
  }),
  web_fetch: buildRepoToolDefinition({
    toolName: 'web_fetch',
    description: 'Fetch one public HTTP(S) URL and return extracted text. Private, local, and internal URLs are blocked.',
    exampleArgs: { url: 'https://example.com/' },
  }),
};

const EXPOSED_REPO_TOOL_NAME_SET = new Set<string>(EXPOSED_REPO_TOOL_NAMES);
const REGISTERED_REPO_TOOL_NAME_SET = new Set<string>(Object.keys(REPO_TOOL_REGISTRY));
/**
 * Tools that can change the working tree, so an identical earlier query may now have a different
 * answer and must not be rejected as a repeat. Typed Git is deliberately absent because its fixed
 * native operations cannot mutate the working tree.
 */
const TREE_MUTATING_TOOL_NAMES = new Set<string>(['run', 'write', 'edit']);

export function normalizeToolName(toolName: string): string {
  return String(toolName || '').trim().toLowerCase();
}

export function isTreeMutatingToolName(toolName: string): boolean {
  return TREE_MUTATING_TOOL_NAMES.has(normalizeToolName(toolName));
}

export function getRepoSearchToolNames(): string[] {
  return [...EXPOSED_REPO_TOOL_NAMES];
}

export function isRepoSearchNativeToolName(toolName: string): boolean {
  const normalized = normalizeToolName(toolName);
  return REGISTERED_REPO_TOOL_NAME_SET.has(normalized);
}

export function sanitizeNonInteractiveAllowedTools(allowedToolNames: string[] | undefined): string[] | undefined {
  if (!Array.isArray(allowedToolNames)) {
    return undefined;
  }
  return allowedToolNames.filter((toolName) => EXPOSED_REPO_TOOL_NAME_SET.has(normalizeToolName(toolName)));
}


export function resolveRepoSearchPlannerToolDefinitions(
  allowedToolNames?: readonly string[],
  visionEnabled = false,
): PlannerToolDefinition[] {
  const requested = Array.isArray(allowedToolNames)
    ? allowedToolNames.map(normalizeToolName)
    : [...EXPOSED_REPO_TOOL_NAMES];
  const seen = new Set<string>();
  const definitions: PlannerToolDefinition[] = [];
  for (const toolName of requested) {
    if (seen.has(toolName) || !REGISTERED_REPO_TOOL_NAME_SET.has(toolName)) {
      continue;
    }
    seen.add(toolName);
    const definition = REPO_TOOL_REGISTRY[toolName];
    definitions.push(visionEnabled && toolName === 'read'
      ? {
        ...definition,
        function: {
          ...definition.function,
          description: buildVisionReadDescription(definition.function.description),
        },
      }
      : definition);
  }
  return definitions;
}

export const TOOL_DEFINITIONS = resolveRepoSearchPlannerToolDefinitions();

/**
 * The rendering flags that decide the shared prompt prefix. They always travel
 * together: splitting them lets one request render a prefix the next one cannot
 * reuse, which silently re-prefills the whole context.
 */
export type PlannerThinkingFlags = {
  thinkingEnabled: boolean;
  reasoningContentEnabled: boolean;
  preserveThinking: boolean;
};

const reserveRequestBuilder = new InferenceRequestBuilder();

export type PlannerRequestStage =
  | 'planner_action'
  | 'finish_validation'
  | 'approval_verdict'
  | 'terminal_synthesis'
  | 'context_compaction';

export type PlannerResponseConstraint =
  | { responseSchema: null; responseSchemaName?: never }
  | { responseSchema: JsonObject; responseSchemaName: string };

type PlannerPromptReserveOptions = PlannerThinkingFlags & {
  config: SiftConfig;
  model: string;
  messageRoles: readonly string[];
  tools: readonly LlamaCppToolDefinition[];
  maxTokens: number;
} & PlannerResponseConstraint;

function buildPlannerResponseFormat(constraint: PlannerResponseConstraint) {
  return constraint.responseSchema === null
    ? null
    : buildLlamaJsonSchemaResponseFormat({
      name: constraint.responseSchemaName,
      schema: constraint.responseSchema,
    });
}

export function buildPlannerRequestPromptReserveText(options: PlannerPromptReserveOptions): string {
  const backend = getActiveInferenceBackend(options.config);
  const samplerDefaults = buildPresetRequestDefaults(getActiveModelPreset(options.config));
  const responseFormat = buildPlannerResponseFormat(options);

  // Derive the request shape from the real request builder so the reserve estimate
  // cannot drift from what is actually sent; message contents are counted
  // separately, so messages stay empty and template overhead is reserved below.
  const requestShape = reserveRequestBuilder.build({
    backend,
    model: options.model,
    messages: [],
    tools: [...options.tools],
    defaults: samplerDefaults,
    maxTokens: options.maxTokens,
    ...(responseFormat ? { responseFormat } : {}),
    thinking: {
      enabled: Boolean(options.thinkingEnabled),
      reasoningContent: Boolean(options.thinkingEnabled && options.reasoningContentEnabled),
      preserve: Boolean(options.thinkingEnabled && options.reasoningContentEnabled && options.preserveThinking),
      effort: samplerDefaults.reasoningEffort,
    },
    llama: { cachePrompt: true },
  });
  return JSON.stringify({
    ...requestShape,
    message_template_reserve: options.messageRoles.map((role) => ({
      role: String(role || 'unknown'),
      template: '<|im_start|>role\\ncontent<|im_end|>',
    })),
  });
}

/**
 * Budget message for planner-action turns. The default preset message ("provide
 * the answer now") reads as an instruction to finish, which made agent runs
 * abandon their remaining tasks mid-plan; a planner's answer is its next action,
 * so exhaustion must steer toward a tool action, never a premature finish.
 */
export const PLANNER_REASONING_BUDGET_MESSAGE = 'Thinking budget exhausted. Emit your next action now. '
  + 'If the task is unfinished, emit the next tool action and keep working on later turns — '
  + 'do not emit finish just because thinking was cut short.';

export type PlannerRequestOptions = Partial<PlannerThinkingFlags> & {
  /** The active preset in here is the sole source of the request's model and samplers. */
  config: SiftConfig;
  baseUrl: string;
  model: string;
  /**
   * Already-serialized protocol messages — the exact array that is sent. The
   * request layer never re-derives them from a transcript, so a caller that
   * snapshots what it passes here has the sent bytes by construction.
   */
  messages: LlamaCppChatMessage[];
  slotId?: number;
  /** Per-attempt allowance, not a total wall clock: bounds the SSE idle gap and caps the retry window. */
  timeoutMs: number;
  maxTokens: number;
  onThinkingDelta?: (accumulatedThinking: string) => void;
  onContentDelta?: (snapshot: LiveContentSnapshot) => void;
  mockResponses?: MockPlannerResponseInput[];
  mockResponseIndex?: number;
  abortSignal?: AbortSignal;
  logger?: JsonLogger | null;
  stage: PlannerRequestStage;
  tools: readonly LlamaCppToolDefinition[];
  toolChoice?: LlamaCppChatRequest['tool_choice'];
  reasoningBudgetMessage?: string;
} & PlannerResponseConstraint;

function extractInlineThinking(raw: string): { thinkingText: string; text: string } {
  const thinkingParts: string[] = [];
  const text = raw.replace(buildInlineThinkPattern(), (_all, thinking: string) => {
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

/**
 * The single serialization path from a transcript to protocol messages. Every
 * request that must share a prompt-cache prefix (planner_action and
 * approval_verdict) is built through this function with the same flags.
 */
export function serializeProtocolMessages(
  messages: readonly ChatMessage[],
  reasoningContentEnabled: boolean,
): LlamaCppChatMessage[] {
  return toProtocolChatMessages(messages.map((message) => serializePlannerMessage(message, reasoningContentEnabled)));
}

/** The one keep-condition for preserved thinking: whatever this keeps is what the request sends, so counting must use it too. */
export function plannerMessageKeepsReasoningContent(message: ChatMessage, reasoningContentEnabled: boolean): boolean {
  return reasoningContentEnabled
    && message.role === 'assistant'
    && typeof message.reasoning_content === 'string'
    && message.reasoning_content.trim().length > 0;
}

function serializePlannerMessage(message: ChatMessage, reasoningContentEnabled: boolean): ChatMessage {
  if (plannerMessageKeepsReasoningContent(message, reasoningContentEnabled)) {
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

export async function requestRepoSearchPlannerProtocolAction(options: PlannerRequestOptions): Promise<PlannerActionResponse> {
  if (options.abortSignal?.aborted) {
    throw options.abortSignal.reason instanceof Error
      ? options.abortSignal.reason
      : new Error(String(options.abortSignal.reason || 'Request aborted.'));
  }

  if (Array.isArray(options.mockResponses)) {
    const index = options.mockResponseIndex || 0;
    if (index >= options.mockResponses.length) return { text: '', thinkingText: '', toolCalls: [], mockExhausted: true };
    const mock = parseMockPlannerResponse(options.mockResponses[index], index);
    const inline = !mock.thinking && mock.content.includes(THINK_OPEN_TAG)
      ? extractInlineThinking(mock.content)
      : null;
    const text = inline?.text ?? mock.content;
    const thinkingText = inline?.thinkingText ?? mock.thinking;
    if (thinkingText) options.onThinkingDelta?.(thinkingText);
    if (text) {
      const classifier = new LiveContentClassifier();
      classifier.observeContent(text);
      if (mock.toolCalls.length > 0) classifier.observeNativeToolCall();
      options.onContentDelta?.(classifier.finish());
    }
    return {
      text,
      thinkingText,
      toolCalls: mock.toolCalls,
      mockExhausted: false,
      nextMockResponseIndex: index + 1,
    };
  }

  const stage = options.stage;
  const allowedToolNames = options.tools.map((toolDefinition) => toolDefinition.function.name);
  const responseFormat = buildPlannerResponseFormat(options);
  const requestUrlForLog = `${options.baseUrl.replace(/\/$/u, '')}/v1` + '/chat/completions';
  const requestPathForLog = new URL(requestUrlForLog).pathname;
  const startedAt = Date.now();
  options.logger?.write({ kind: 'provider_request_start', stage, method: 'POST', url: requestUrlForLog, path: requestPathForLog });

  let response;
  try {
    response = await retryProviderRequest(
      () => new LlamaCppClient().chat({
        config: options.config,
        baseUrl: options.baseUrl,
        model: options.model,
        messages: options.messages,
        tools: [...options.tools],
        ...(options.toolChoice === undefined ? {} : { toolChoice: options.toolChoice }),
        maxTokens: options.maxTokens,
        slotId: options.slotId,
        responseFormat: responseFormat ?? undefined,
        reasoningOverride: options.thinkingEnabled ? 'on' : 'off',
        allowedToolNames,
        idleTimeoutSeconds: options.timeoutMs / 1000,
        retry: false,
        abortSignal: options.abortSignal,
        reasoningBudgetMessage: options.reasoningBudgetMessage,
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

  const inlineThinking = !response.reasoningText && response.text.includes(THINK_OPEN_TAG)
    ? extractInlineThinking(response.text)
    : null;
  const rawChoiceText = inlineThinking ? inlineThinking.text : response.text;
  const thinkingText = inlineThinking ? inlineThinking.thinkingText : response.reasoningText;
  const text = response.stoppedEarly && response.earlyStopReason
    ? [`SiftKit stopped the planner stream early: ${response.earlyStopReason}.`, rawChoiceText.trim()].filter(Boolean).join('\n')
    : rawChoiceText;

  return {
    text: text.trim(),
    thinkingText,
    toolCalls: response.toolCalls,
    mockExhausted: false,
    promptCacheTokens: response.usage.promptCacheTokens,
    promptEvalTokens: response.usage.promptEvalTokens,
    promptEvalDurationMs: response.usage.promptEvalDurationMs ?? null,
    generationDurationMs: response.usage.generationDurationMs ?? null,
    speculativeAcceptedTokens: response.usage.speculativeAcceptedTokens ?? null,
    speculativeGeneratedTokens: response.usage.speculativeGeneratedTokens ?? null,
    ...(response.thinkingBudgetExhausted ? { thinkingBudgetExhausted: true } : {}),
  };
}

export async function requestFinishValidation(options: Partial<PlannerThinkingFlags> & {
  config: SiftConfig;
  baseUrl: string;
  model: string;
  prompt: string;
  timeoutMs: number;
  maxTokens: number;
  mockResponses?: MockPlannerResponseInput[];
  mockResponseIndex?: number;
  logger?: JsonLogger | null;
}): Promise<PlannerActionResponse> {
  return requestRepoSearchPlannerProtocolAction({
    config: options.config,
    baseUrl: options.baseUrl,
    model: options.model,
    messages: serializeProtocolMessages([{ role: 'user', content: options.prompt }], options.reasoningContentEnabled === true),
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
    tools: [],
  });
}

/**
 * Snapshot of the serialized prompt an in-flight planner request was sent with.
 * An approval verdict may only be requested as an extension of this prompt —
 * anything else re-prefills the whole context and breaks the prompt cache.
 */
export type ExecutingPlannerRequest = {
  serializedMessageJson: string[];
  flags: PlannerThinkingFlags;
  serializedToolsJson: string;
};

/**
 * Takes the very array the planner request is sent with, so the snapshot cannot
 * drift from the sent bytes even if the request layer changes.
 */
export function captureExecutingPlannerRequest(
  serializedMessages: readonly LlamaCppChatMessage[],
  flags: PlannerThinkingFlags,
  tools: readonly LlamaCppToolDefinition[],
): ExecutingPlannerRequest {
  return {
    serializedMessageJson: serializedMessages.map((message) => JSON.stringify(message)),
    flags,
    serializedToolsJson: JSON.stringify(tools),
  };
}

function assertExtendsExecutingPlannerRequest(
  executing: ExecutingPlannerRequest,
  serializedMessages: readonly LlamaCppChatMessage[],
): void {
  const prefix = executing.serializedMessageJson;
  if (prefix.length > serializedMessages.length) {
    throw new Error(
      `approval_verdict prompt diverged from the executing planner request: the verdict prompt serializes to ${serializedMessages.length} messages but the executing request sent ${prefix.length}; prompt-cache prefix broken.`,
    );
  }
  for (let index = 0; index < prefix.length; index += 1) {
    if (prefix[index] !== JSON.stringify(serializedMessages[index])) {
      throw new Error(
        `approval_verdict prompt diverged from the executing planner request at message ${index}; prompt-cache prefix broken.`,
      );
    }
  }
}

/** The verdict is a two-field JSON object; only mirrored thinking needs headroom before it. */
const APPROVAL_VERDICT_MAX_TOKENS = 512;
const APPROVAL_VERDICT_THINKING_MAX_TOKENS = 4096;

/** Executing transcript, pending assistant tool call, then the transient verdict question. */
export function buildApprovalVerdictPromptMessages(
  transcriptMessages: ChatMessage[],
  pendingMessages: ChatMessage[],
  question: string,
): ChatMessage[] {
  return [...transcriptMessages, ...pendingMessages, { role: 'user', content: question }];
}

export async function requestApprovalVerdict(options: {
  config: SiftConfig;
  baseUrl: string;
  model: string;
  transcriptMessages: ChatMessage[];
  pendingMessages: ChatMessage[];
  question: string;
  executing: ExecutingPlannerRequest;
  slotId?: number;
  timeoutMs: number;
  mockResponses?: MockPlannerResponseInput[];
  mockResponseIndex?: number;
  abortSignal?: AbortSignal;
  logger?: JsonLogger | null;
}): Promise<PlannerActionResponse> {
  const serializedMessages = serializeProtocolMessages(
    buildApprovalVerdictPromptMessages(
      options.transcriptMessages,
      options.pendingMessages,
      options.question,
    ),
    options.executing.flags.reasoningContentEnabled,
  );
  assertExtendsExecutingPlannerRequest(options.executing, serializedMessages);
  return requestRepoSearchPlannerProtocolAction({
    config: options.config,
    baseUrl: options.baseUrl,
    model: options.model,
    messages: serializedMessages,
    slotId: options.slotId,
    timeoutMs: options.timeoutMs,
    maxTokens: clampToPresetMaxTokens(
      options.config,
      options.executing.flags.thinkingEnabled
        ? APPROVAL_VERDICT_THINKING_MAX_TOKENS
        : APPROVAL_VERDICT_MAX_TOKENS,
    ),
    // The thinking flags mirror the executing planner request: they feed the
    // server-side chat_template_kwargs, and any difference re-renders (and so
    // re-prefills) the shared prompt prefix.
    ...options.executing.flags,
    mockResponses: options.mockResponses,
    mockResponseIndex: options.mockResponseIndex,
    abortSignal: options.abortSignal,
    logger: options.logger,
    stage: 'approval_verdict',
    responseSchema: buildApprovalVerdictJsonSchema(),
    responseSchemaName: 'siftkit_approval_verdict',
    tools: LlamaCppToolDefinitionsSchema.parse(
      parseJsonValueText(options.executing.serializedToolsJson),
    ),
    toolChoice: 'none',
  });
}

export async function requestTerminalSynthesis(options: Partial<PlannerThinkingFlags> & {
  config: SiftConfig;
  baseUrl: string;
  model: string;
  prompt: string;
  timeoutMs: number;
  maxTokens: number;
  mockResponses?: MockPlannerResponseInput[];
  mockResponseIndex?: number;
  logger?: JsonLogger | null;
  onContentDelta?: (snapshot: LiveContentSnapshot) => void;
}): Promise<PlannerActionResponse> {
  return requestRepoSearchPlannerProtocolAction({
    config: options.config,
    baseUrl: options.baseUrl,
    model: options.model,
    messages: serializeProtocolMessages([{ role: 'user', content: options.prompt }], options.reasoningContentEnabled === true),
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
    tools: [],
    onContentDelta: options.onContentDelta,
  });
}

/**
 * The prefix-preserving compaction request: the completed history serialized unchanged,
 * with only the summary instruction appended, so the provider can reuse the prompt-cache
 * prefix the planner requests already established.
 */
export function buildContextCompactionPromptMessages(
  history: readonly ChatMessage[],
  instruction: string,
  reasoningContentEnabled: boolean,
): LlamaCppChatMessage[] {
  const messages: ChatMessage[] = [
    ...history,
    { role: 'user', content: instruction },
  ];
  return serializeProtocolMessages(messages, reasoningContentEnabled);
}

/**
 * The context-compaction summarization call. Free-form text with no tools and no
 * response schema: the output becomes an assistant message, not a planner action.
 */
export async function requestContextCompactionSummary(options: Partial<PlannerThinkingFlags> & {
  config: SiftConfig;
  baseUrl: string;
  model: string;
  messages: readonly ChatMessage[];
  instruction: string;
  timeoutMs: number;
  maxTokens: number;
  slotId?: number;
  mockResponses?: MockPlannerResponseInput[];
  mockResponseIndex?: number;
  abortSignal?: AbortSignal;
  logger?: JsonLogger | null;
}): Promise<PlannerActionResponse> {
  return requestRepoSearchPlannerProtocolAction({
    config: options.config,
    baseUrl: options.baseUrl,
    model: options.model,
    messages: buildContextCompactionPromptMessages(options.messages, options.instruction, options.reasoningContentEnabled === true),
    slotId: options.slotId,
    timeoutMs: options.timeoutMs,
    maxTokens: options.maxTokens,
    thinkingEnabled: options.thinkingEnabled,
    reasoningContentEnabled: options.reasoningContentEnabled,
    preserveThinking: options.preserveThinking,
    mockResponses: options.mockResponses,
    mockResponseIndex: options.mockResponseIndex,
    abortSignal: options.abortSignal,
    logger: options.logger,
    stage: 'context_compaction',
    responseSchema: null,
    tools: [],
  });
}

export { isTransientProviderError } from '../lib/provider-helpers.js';

export function renderTaskTranscript(
  messages: ChatMessage[],
  options: { includeReasoningContent: boolean },
): string {
  return messages.map((message) => {
    const sections = [`[${String(message.role || 'unknown')}]`];
    if (options.includeReasoningContent && plannerMessageKeepsReasoningContent(message, true)) {
      sections.push(`[reasoning]\n${String(message.reasoning_content)}`);
    }
    // Content is a parts array whenever the turn carries images; reading only the
    // string form would drop the user's prose from the rendered transcript too.
    const contentText = extractContentText(message.content);
    if (contentText) sections.push(contentText);
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

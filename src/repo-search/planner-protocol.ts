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
};

export type ToolAction = {
  action: 'tool';
  tool_name: 'run_repo_cmd';
  args: { command: string };
};

export type ToolBatchAction = {
  action: 'tool_batch';
  tool_calls: Array<{
    tool_name: 'run_repo_cmd';
    args: { command: string };
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

export const TOOL_DEFINITIONS = [
  {
    type: 'function' as const,
    function: {
      name: 'run_repo_cmd',
      description: 'Run one read-only repo command to inspect files. Command must be non-mutating.',
      parameters: {
        type: 'object',
        properties: { command: { type: 'string' } },
        required: ['command'],
      },
    },
  },
];

// ---------------------------------------------------------------------------
// Grammar definitions
// ---------------------------------------------------------------------------

export function plannerGrammar(): string {
  return [
    'root ::= tool_batch_action | tool_action | finish_action',
    'tool_batch_action ::= "{" ws "\\"action\\"" ws ":" ws "\\"tool_batch\\"" ws "," ws "\\"tool_calls\\"" ws ":" ws "[" ws tool_batch_items ws "]" ws "}"',
    'tool_batch_items ::= tool_batch_item (ws "," ws tool_batch_item)*',
    'tool_batch_item ::= "{" ws "\\"tool_name\\"" ws ":" ws "\\"run_repo_cmd\\"" ws "," ws "\\"args\\"" ws ":" ws args_obj ws "}"',
    'tool_action ::= "{" ws "\\"action\\"" ws ":" ws "\\"tool\\"" ws "," ws "\\"tool_name\\"" ws ":" ws "\\"run_repo_cmd\\"" ws "," ws "\\"args\\"" ws ":" ws args_obj ws "}"',
    'args_obj ::= "{" ws "\\"command\\"" ws ":" ws string ws "}"',
    'finish_action ::= "{" ws "\\"action\\"" ws ":" ws "\\"finish\\"" ws "," ws "\\"output\\"" ws ":" ws string (ws "," ws "\\"confidence\\"" ws ":" ws number)? ws "}"',
    'number ::= "-"? int frac? exp?',
    'int ::= "0" | [1-9] [0-9]*',
    'frac ::= "." [0-9]+',
    'exp ::= [eE] [+-]? [0-9]+',
    'string ::= "\\"" char* "\\""',
    'char ::= [^"\\\\\\x7F\\x00-\\x1F] | "\\\\" escape',
    'escape ::= ["\\\\/bfnrt] | "u" hex hex hex hex',
    'hex ::= [0-9a-fA-F]',
    'ws ::= [ \\t\\n\\r]*',
  ].join('\n');
}

function finishValidationGrammar(): string {
  return [
    'root ::= object',
    'object ::= "{" ws "\\"verdict\\"" ws ":" ws verdict ws "," ws "\\"reason\\"" ws ":" ws string ws "}"',
    'verdict ::= "\\"pass\\"" | "\\"fail\\""',
    'string ::= "\\"" char* "\\""',
    'char ::= [^"\\\\\\x7F\\x00-\\x1F] | "\\\\" escape',
    'escape ::= ["\\\\/bfnrt] | "u" hex hex hex hex',
    'hex ::= [0-9a-fA-F]',
    'ws ::= [ \\t\\n\\r]*',
  ].join('\n');
}

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

function tryRecoverMalformedPlannerToolAction(rawText: string): ToolAction | null {
  if (!/"action"\s*:\s*"tool"/iu.test(rawText) || !/"tool_name"\s*:\s*"run_repo_cmd"/iu.test(rawText)) {
    return null;
  }
  const commandMatch = /"command"\s*:\s*"([\s\S]*)"\s*\}\s*\}\s*$/u.exec(rawText);
  if (!commandMatch?.[1]) return null;
  const recoveredCommand = decodeJsonStringLoose(commandMatch[1]).trim();
  if (!recoveredCommand) return null;
  return { action: 'tool', tool_name: 'run_repo_cmd', args: { command: recoveredCommand } };
}

function parseRepoToolCallCandidate(toolCall: {
  function?: { name?: string; arguments?: unknown };
  name?: string;
  arguments?: unknown;
} | null | undefined): ToolAction | null {
  const name = typeof toolCall?.function?.name === 'string' ? toolCall.function.name
    : typeof toolCall?.name === 'string' ? toolCall.name : '';
  if (name !== 'run_repo_cmd') return null;

  let args = toolCall?.function?.arguments ?? toolCall?.arguments;
  if (typeof args === 'string') { try { args = JSON.parse(args); } catch { return null; } }
  if (!args || typeof args !== 'object' || Array.isArray(args) || typeof (args as Record<string, unknown>).command !== 'string') return null;

  return {
    action: 'tool',
    tool_name: 'run_repo_cmd',
    args: { command: (args as { command: string }).command },
  };
}

function actionFromToolCall(choice: Record<string, unknown>): string | null {
  type ToolCallLike = { function?: { name?: string; arguments?: unknown }; name?: string; arguments?: unknown };
  const message = choice?.message as Record<string, unknown> | undefined;
  const toolCalls = [
    ...(((message?.tool_calls as ToolCallLike[] | undefined) || []).map((toolCall) => parseRepoToolCallCandidate(toolCall)).filter(Boolean) as ToolAction[]),
    ...((((choice?.tool_calls as ToolCallLike[] | undefined) || []).map((toolCall) => parseRepoToolCallCandidate(toolCall)).filter(Boolean)) as ToolAction[]),
  ];
  const functionCall = parseRepoToolCallCandidate(
    (message?.function_call as ToolCallLike | undefined) ?? (choice?.function_call as ToolCallLike | undefined),
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

export function parsePlannerAction(text: string): PlannerAction {
  const normalized = stripCodeFence(text);
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(normalized) as Record<string, unknown>;
  } catch (error) {
    const recovered = tryRecoverMalformedPlannerToolAction(normalized);
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
    if (toolName !== 'run_repo_cmd') {
      throw new Error('Provider returned an invalid planner tool action.');
    }
    if (!parsed.args || typeof parsed.args !== 'object' || Array.isArray(parsed.args)) {
      throw new Error('Provider returned an invalid planner tool action.');
    }
    const args = parsed.args as Record<string, unknown>;
    // Accept "cmd" as fallback for "command"
    const commandValue = typeof args.command === 'string' ? args.command
      : typeof args.cmd === 'string' ? args.cmd : '';
    if (!commandValue.trim()) {
      throw new Error('Provider returned an invalid planner tool action.');
    }
    return { action: 'tool', tool_name: 'run_repo_cmd', args: { command: commandValue.trim() } };
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
      if (toolName !== 'run_repo_cmd') {
        throw new Error('Provider returned an invalid planner tool batch action.');
      }
      if (!toolRecord.args || typeof toolRecord.args !== 'object' || Array.isArray(toolRecord.args)) {
        throw new Error('Provider returned an invalid planner tool batch action.');
      }
      const args = toolRecord.args as Record<string, unknown>;
      const commandValue = typeof args.command === 'string' ? args.command
        : typeof args.cmd === 'string' ? args.cmd : '';
      if (!commandValue.trim()) {
        throw new Error('Provider returned an invalid planner tool batch action.');
      }
      return {
        tool_name: 'run_repo_cmd' as const,
        args: { command: commandValue.trim() },
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
  /** Override the grammar (default: plannerGrammar()). Pass null to omit. */
  grammar?: string | null;
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
  const grammar = options.grammar === undefined ? plannerGrammar() : options.grammar;
  const includeTools = stage === 'planner_action' && !grammar;

  const bodyObj: Record<string, unknown> = {
    model: options.model,
    messages: options.messages,
    cache_prompt: true,
    ...(Number.isInteger(options.slotId) ? { id_slot: Number(options.slotId) } : {}),
    temperature: 0.1,
    top_p: 0.95,
    max_tokens: options.requestMaxTokens,
    ...(includeTools ? { tools: TOOL_DEFINITIONS, parallel_tool_calls: true } : {}),
    chat_template_kwargs: { enable_thinking: !grammar && Boolean(options.thinkingEnabled) },
    ...(grammar ? { grammar } : {}),
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
  const synthesized = actionFromToolCall(firstChoice);
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
              for (const tc of delta.tool_calls as Array<{ index?: number; function?: { name?: string; arguments?: string } }>) {
                const idx = tc.index ?? 0;
                if (!toolCalls[idx]) toolCalls[idx] = { name: '', arguments: '' };
                if (tc.function?.name) toolCalls[idx].name += tc.function.name;
                if (tc.function?.arguments) toolCalls[idx].arguments += tc.function.arguments;
              }
            }
            if (deltaThinking) {
              thinkingText += deltaThinking;
              options.onThinkingDelta?.(thinkingText);
            }
            if (deltaContent) {
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
          }))
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
        resolve({
          text: typeof text === 'string' ? text.trim() : text,
          thinkingText: finalThinkingText,
          mockExhausted: false,
          promptTokens,
          completionTokens,
          usageThinkingTokens,
          promptCacheTokens,
          promptEvalTokens,
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
    thinkingEnabled: true,
    mockResponses: options.mockResponses,
    mockResponseIndex: options.mockResponseIndex,
    logger: options.logger,
    stage: 'finish_validation',
    grammar: finishValidationGrammar(),
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
    thinkingEnabled: true,
    mockResponses: options.mockResponses,
    mockResponseIndex: options.mockResponseIndex,
    logger: options.logger,
    stage: 'terminal_synthesis',
    grammar: null,
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

export function buildRepoSearchAssistantToolMessage(command: string, toolCallId: string): ChatMessage {
  return {
    role: 'assistant',
    content: '',
    tool_calls: [{
      id: toolCallId,
      type: 'function',
      function: { name: 'run_repo_cmd', arguments: JSON.stringify({ command }) },
    }],
  };
}

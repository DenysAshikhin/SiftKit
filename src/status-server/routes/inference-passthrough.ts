import {
  request as httpRequest,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type OutgoingHttpHeaders,
  type ServerResponse,
} from 'node:http';
import { request as httpsRequest } from 'node:https';

import type { ModelRuntimePreset, SiftConfig } from '../../config/types.js';
import { getConfiguredModel } from '../../config/getters.js';
import { isJsonObject, type JsonObject, type JsonValue } from '../../lib/json-types.js';
import { parseJsonValueText } from '../../lib/json.js';
import { httpClient } from '../../lib/http-client.js';
import { buildPresetRequestDefaults } from '../../inference-presets/preset-compatibility.js';
import { getInferenceRequestCompatibility } from '../../inference-presets/request-compatibility.js';
import { getActiveModelPreset, getManagedLlamaInternalBaseUrl, readConfig } from '../config-store.js';
import { serverLogger } from '../server-logger.js';
import { readBody, sendJson } from '../http-utils.js';
import { RouteTable, type RouteEndpoint, type RouteMatch } from '../route-table.js';
import {
  acquireModelRequestWithWait,
  ensureActivePresetReadyForModelRequest,
  releaseModelRequest,
} from '../server-ops.js';
import type { ServerContext } from '../server-types.js';

const CHAT_PATH = '/v1/chat/completions';
const MODELS_PATH = '/v1/models';
const LLAMA_TOKENIZE_PATH = '/tokenize';
const EXL3_TOKENIZE_PATH = '/v1/token/encode';
const CHAT_TIMEOUT_MS = 600_000;
const TOKENIZE_TIMEOUT_MS = 60_000;
const HOP_BY_HOP_RESPONSE_HEADERS = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade',
]);

function isInferencePath(pathname: string): boolean {
  return pathname === MODELS_PATH
    || pathname === CHAT_PATH
    || pathname === LLAMA_TOKENIZE_PATH
    || pathname === EXL3_TOKENIZE_PATH;
}

function getBaseUrl(config: SiftConfig, preset: ModelRuntimePreset): string | null {
  if (preset.Backend === 'llama') return getManagedLlamaInternalBaseUrl(config) ?? preset.BaseUrl;
  return preset.BaseUrl;
}

function isSelfBaseUrl(ctx: ServerContext, baseUrl: string): boolean {
  return new URL(baseUrl).origin === new URL(ctx.getServiceBaseUrl()).origin;
}

function buildHeaders(req: IncomingMessage, bodyText: string): OutgoingHttpHeaders {
  const headers: OutgoingHttpHeaders = {};
  if (req.headers['content-type']) headers['content-type'] = req.headers['content-type'];
  if (req.headers.accept) headers.accept = req.headers.accept;
  if (req.headers.authorization) headers.authorization = req.headers.authorization;
  if (bodyText) headers['content-length'] = Buffer.byteLength(bodyText, 'utf8');
  return headers;
}

function buildResponseHeaders(headers: IncomingHttpHeaders): OutgoingHttpHeaders {
  const downstream: OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value !== undefined && !HOP_BY_HOP_RESPONSE_HEADERS.has(name.toLowerCase())) downstream[name] = value;
  }
  return downstream;
}

function setNumberDefault(body: JsonObject, key: string, value: number): void {
  if (typeof body[key] !== 'number') body[key] = value;
}

function applyThinkingDefaults(body: JsonObject, preset: ModelRuntimePreset): void {
  const compatibility = getInferenceRequestCompatibility(preset.Backend);
  if (!isJsonObject(body.chat_template_kwargs)) body.chat_template_kwargs = {};
  const template = body.chat_template_kwargs;
  const thinkingEnabled = preset.Reasoning === 'on';
  if (typeof template.enable_thinking !== 'boolean') template.enable_thinking = thinkingEnabled;
  if (thinkingEnabled && preset.PreserveThinking && typeof template.preserve_thinking !== 'boolean') {
    template.preserve_thinking = true;
  }
  if (
    compatibility.reasoningContent
    && thinkingEnabled
    && preset.ReasoningContent
    && typeof template.reasoning_content !== 'boolean'
  ) template.reasoning_content = true;
}

function validateChatBody(bodyText: string): number {
  const parsed = parseJsonValueText(bodyText);
  if (!isJsonObject(parsed) || !Array.isArray(parsed.messages)) {
    throw new Error('Expected a JSON object with a messages array.');
  }
  return parsed.messages.length;
}

function translateChatBody(bodyText: string, preset: ModelRuntimePreset): string {
  const parsed = parseJsonValueText(bodyText);
  if (!isJsonObject(parsed) || !Array.isArray(parsed.messages)) {
    throw new Error('Expected a JSON object with a messages array.');
  }
  const defaults = buildPresetRequestDefaults(preset);
  parsed.model = preset.Model ?? preset.id;
  setNumberDefault(parsed, 'max_tokens', defaults.maxTokens);
  setNumberDefault(parsed, 'temperature', defaults.temperature);
  setNumberDefault(parsed, 'top_p', defaults.topP);
  setNumberDefault(parsed, 'top_k', defaults.topK);
  setNumberDefault(parsed, 'min_p', defaults.minP);
  setNumberDefault(parsed, 'presence_penalty', defaults.presencePenalty);
  applyThinkingDefaults(parsed, preset);
  const compatibility = getInferenceRequestCompatibility(preset.Backend);
  setNumberDefault(parsed, compatibility.repetitionPenaltyKey, defaults.repetitionPenalty);
  for (const field of compatibility.removedFields) delete parsed[field];
  return JSON.stringify(parsed);
}

function readTokenizeText(bodyText: string, requestPath: string): string {
  const parsed = parseJsonValueText(bodyText);
  if (!isJsonObject(parsed)) throw new Error('Expected a JSON object.');
  const key = requestPath === LLAMA_TOKENIZE_PATH ? 'content' : 'text';
  const text = parsed[key];
  if (typeof text !== 'string') throw new Error(`Expected '${key}' to be a string.`);
  return text;
}

function getTokenArray(value: JsonValue): JsonValue[] | null {
  if (!isJsonObject(value) || !Array.isArray(value.tokens)) return null;
  return value.tokens;
}

async function proxyStreamingRequest(
  ctx: ServerContext,
  req: IncomingMessage,
  res: ServerResponse,
  baseUrl: string,
  upstreamPath: string,
  bodyText: string,
): Promise<void> {
  if (isSelfBaseUrl(ctx, baseUrl)) throw new Error('The active preset BaseUrl points at the SiftKit passthrough server.');
  const upstreamUrl = new URL(upstreamPath, `${baseUrl.replace(/\/$/u, '')}/`);
  const transport = upstreamUrl.protocol === 'https:' ? httpsRequest : httpRequest;
  await new Promise<void>((resolve, reject) => {
    const upstream = transport({
      protocol: upstreamUrl.protocol,
      hostname: upstreamUrl.hostname,
      port: upstreamUrl.port || (upstreamUrl.protocol === 'https:' ? 443 : 80),
      path: upstreamUrl.pathname,
      method: 'POST',
      agent: httpClient.localAgent(upstreamUrl),
      headers: buildHeaders(req, bodyText),
    }, (upstreamResponse) => {
      res.writeHead(upstreamResponse.statusCode || 502, buildResponseHeaders(upstreamResponse.headers));
      upstreamResponse.pipe(res);
      upstreamResponse.on('end', resolve);
      upstreamResponse.on('error', reject);
    });
    upstream.on('error', reject);
    upstream.setTimeout(CHAT_TIMEOUT_MS, () => upstream.destroy(new Error('Inference passthrough timed out.')));
    req.on('aborted', () => upstream.destroy(new Error('Downstream inference request aborted.')));
    upstream.end(bodyText);
  });
}

async function proxyTokenizeRequest(
  req: IncomingMessage,
  res: ServerResponse,
  baseUrl: string,
  preset: ModelRuntimePreset,
  requestPath: string,
  requestText: string,
): Promise<void> {
  const upstreamPath = preset.Backend === 'exl3' ? EXL3_TOKENIZE_PATH : LLAMA_TOKENIZE_PATH;
  const upstreamBody = preset.Backend === 'exl3' ? { text: requestText } : { content: requestText };
  const response = await fetch(new URL(upstreamPath, `${baseUrl.replace(/\/$/u, '')}/`), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(req.headers.authorization ? { authorization: req.headers.authorization } : {}),
    },
    body: JSON.stringify(upstreamBody),
    signal: AbortSignal.timeout(TOKENIZE_TIMEOUT_MS),
  });
  const responseText = await response.text();
  if (!response.ok) {
    res.writeHead(response.status, { 'content-type': response.headers.get('content-type') ?? 'application/json' });
    res.end(responseText);
    return;
  }
  const parsed = parseJsonValueText(responseText);
  const tokens = getTokenArray(parsed);
  if (requestPath === LLAMA_TOKENIZE_PATH) {
    const count = isJsonObject(parsed) && typeof parsed.count === 'number'
      ? parsed.count
      : isJsonObject(parsed) && typeof parsed.length === 'number'
        ? parsed.length
        : tokens?.length;
    if (count === undefined) throw new Error('Upstream tokenization response did not contain a token count.');
    sendJson(res, 200, { count });
    return;
  }
  if (!tokens) throw new Error('Upstream tokenization response did not contain a tokens array.');
  sendJson(res, 200, { tokens, length: tokens.length });
}

class ModelsEndpoint implements RouteEndpoint {
  async handle(ctx: ServerContext, _req: IncomingMessage, res: ServerResponse): Promise<void> {
    const config = readConfig(ctx.configPath);
    sendJson(res, 200, { data: [{ id: getConfiguredModel(config), object: 'model' }] });
  }
}

class WorkloadEndpoint implements RouteEndpoint {
  async handle(ctx: ServerContext, req: IncomingMessage, res: ServerResponse, match: RouteMatch): Promise<void> {
    let bodyText: string;
    let requestText: string | null = null;
    let chatMessageCount = 0;
    try {
      bodyText = await readBody(req);
      if (match.pathname === CHAT_PATH) chatMessageCount = validateChatBody(bodyText);
      else requestText = readTokenizeText(bodyText, match.pathname);
    } catch (error) {
      sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
      return;
    }
    const lock = await acquireModelRequestWithWait(ctx, 'inference_passthrough', req, res);
    if (!lock) return;
    try {
      await ensureActivePresetReadyForModelRequest(ctx);
      const currentConfig = readConfig(ctx.configPath);
      const currentPreset = getActiveModelPreset(currentConfig);
      const baseUrl = getBaseUrl(currentConfig, currentPreset);
      if (!baseUrl) {
        sendJson(res, 503, { error: 'The active preset BaseUrl is not configured.' });
        return;
      }
      if (match.pathname === CHAT_PATH) {
        const translatedBody = translateChatBody(bodyText, currentPreset);
        serverLogger.event({
          scope: 'proxy',
          id: '',
          event: 'forward',
          fields: `path=${CHAT_PATH} base_url=${baseUrl} `
            + `messages=${chatMessageCount} body_chars=${translatedBody.length}`,
        });
        await proxyStreamingRequest(ctx, req, res, baseUrl, CHAT_PATH, translatedBody);
      } else if (requestText !== null) {
        await proxyTokenizeRequest(req, res, baseUrl, currentPreset, match.pathname, requestText);
      }
      ctx.idleSummaryPending = true;
    } catch (error) {
      if (!res.headersSent && !res.destroyed) sendJson(res, 502, { error: error instanceof Error ? error.message : String(error) });
      else res.destroy(error instanceof Error ? error : new Error(String(error)));
    } finally {
      releaseModelRequest(ctx, lock.token);
    }
  }
}

const ROUTES = new RouteTable([
  { method: 'GET', path: MODELS_PATH, endpoint: new ModelsEndpoint() },
  { method: 'POST', path: CHAT_PATH, endpoint: new WorkloadEndpoint() },
  { method: 'POST', path: LLAMA_TOKENIZE_PATH, endpoint: new WorkloadEndpoint() },
  { method: 'POST', path: EXL3_TOKENIZE_PATH, endpoint: new WorkloadEndpoint() },
]);

export async function handleInferencePassthroughRoute(
  ctx: ServerContext,
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
): Promise<boolean> {
  if (!isInferencePath(pathname)) return false;
  if (await ROUTES.handle(ctx, req, res, pathname)) return true;
  sendJson(res, 405, { error: 'Method not allowed.' });
  return true;
}

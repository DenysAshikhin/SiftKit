import {
  request as httpRequest,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type OutgoingHttpHeaders,
  type ServerResponse,
} from 'node:http';
import { request as httpsRequest } from 'node:https';
import { randomUUID } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';

import type { ThroughputAuditIdentity, InferenceThroughput } from '@siftkit/contracts';
import type { ModelRuntimePreset } from '../../config/types.ts';
import { getConfiguredModel } from '../../config/getters.ts';
import { isJsonObject, type JsonObject, type JsonValue } from '../../lib/json-types.ts';
import { parseJsonValueText } from '../../lib/json.ts';
import { httpClient } from '../../lib/http-client.ts';
import { SseFrameParser } from '../../lib/sse-frame-parser.ts';
import {
  emptyInferenceThroughput,
  observeTabbyThroughput,
  readTabbyThroughput,
  unmeasuredInferenceThroughput,
} from '../../lib/inference-throughput.ts';
import { auditInferenceThroughput, UNPUBLISHED_RATES } from '../inference-throughput-audit.ts';
import { buildPresetRequestDefaults } from '../../inference-presets/preset-compatibility.ts';
import { resolveGenerationTokenLimit } from '../../lib/context-token-budget.ts';
import {
  countPassthroughPromptTokens,
  PassthroughChatBodySchema,
  type PassthroughChatBody,
} from '../passthrough-chat-prompt.ts';
import {
  InferenceClient,
  TABBY_TOKEN_ENCODE_PATH,
  TabbyTokenEncodeResponseSchema,
  type TokenEncodeTarget,
} from '../../llm-protocol/inference-client.ts';
import type { PromptTokenCounter } from '../../providers/prompt-token-counter.ts';
import { z } from '../../lib/zod.ts';
import { INFERENCE_REQUEST_COMPATIBILITY } from '../../inference-presets/preset-compatibility.ts';
import { readConfig } from '../config-store.ts';
import { serverLogger } from '../server-logger.ts';
import { toError } from '../../lib/errors.ts';
import { readBody, sendBodyReadError, sendJson } from '../http-utils.ts';
import { RouteTable, type RouteEndpoint, type RouteMatch } from '../route-table.ts';
import {
  acquireModelRequestWithWait,
  releaseModelRequest,
} from '../server-ops.ts';
import type { ModelRequestLock, ServerContext } from '../server-types.ts';

const CHAT_PATH = '/v1/chat/completions';
const MODELS_PATH = '/v1/models';
const TokenizeRequestSchema = z.object({ text: z.string() }).loose();
const inferenceClient = new InferenceClient();
const CHAT_TIMEOUT_MS = 600_000;
const SSE_OBSERVE_LIMIT_CHARS = 256 * 1024;
const JSON_OBSERVE_LIMIT_CHARS = 4 * 1024 * 1024;
const HOP_BY_HOP_RESPONSE_HEADERS = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade',
]);

function isInferencePath(pathname: string): boolean {
  return pathname === MODELS_PATH
    || pathname === CHAT_PATH
    || pathname === TABBY_TOKEN_ENCODE_PATH;
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

/** The preset owns thinking; a caller's `chat_template_kwargs` is replaced, not merged. */
function buildThinkingKwargs(preset: ModelRuntimePreset): JsonObject {
  const compatibility = INFERENCE_REQUEST_COMPATIBILITY;
  const thinkingEnabled = preset.Reasoning === 'on';
  const reasoningContent = thinkingEnabled && preset.ReasoningContent;
  return {
    enable_thinking: thinkingEnabled,
    ...(compatibility.reasoningContent && reasoningContent ? { reasoning_content: true } : {}),
    ...(reasoningContent && preset.PreserveThinking ? { preserve_thinking: true } : {}),
    ...(thinkingEnabled ? { reasoning_effort: preset.ReasoningEffort } : {}),
  };
}

/** Parses a request body against its schema; a mismatch reads as the request's fault. */
function parseRequestBody<T>(bodyText: string, schema: z.ZodType<T>): T {
  const parsed = schema.safeParse(parseJsonValueText(bodyText));
  if (!parsed.success) throw new Error(z.prettifyError(parsed.error));
  return parsed.data;
}

type TranslatedChatBody = { text: string; usageOptIn: boolean };

/** A caller expects usage on a non-streaming response or when it asked for a usage frame. */
function readUsageOptIn(body: PassthroughChatBody): boolean {
  return body.stream !== true || body.stream_options?.include_usage === true;
}

async function translateChatBody(
  body: PassthroughChatBody,
  preset: ModelRuntimePreset,
  promptCounter: PromptTokenCounter,
  target: TokenEncodeTarget,
): Promise<TranslatedChatBody> {
  const defaults = buildPresetRequestDefaults(preset);
  const model = preset.Model ?? preset.id;
  const templateKwargs = buildThinkingKwargs(preset);
  const callerMaxTokens = body.max_tokens;
  // The preset is authoritative for sampling; a caller may only lower the ceiling the
  // context leaves once this prompt, as the engine tokenizes it, is accounted for.
  const maxTokens = resolveGenerationTokenLimit({
    totalContextTokens: preset.NumCtx,
    promptTokenCount: await countPassthroughPromptTokens(promptCounter, {
      target,
      model,
      body,
      templateKwargs,
      totalContextTokens: preset.NumCtx,
    }),
    operationMaxTokens: typeof callerMaxTokens === 'number' && Number.isInteger(callerMaxTokens) && callerMaxTokens >= 1
      ? callerMaxTokens
      : undefined,
  });
  const compatibility = INFERENCE_REQUEST_COMPATIBILITY;
  const forwarded = {
    ...body,
    model,
    chat_template_kwargs: templateKwargs,
    max_tokens: maxTokens,
    temperature: defaults.temperature,
    top_p: defaults.topP,
    top_k: defaults.topK,
    min_p: defaults.minP,
    presence_penalty: defaults.presencePenalty,
    [compatibility.repetitionPenaltyKey]: defaults.repetitionPenalty,
  };
  return { text: JSON.stringify(forwarded), usageOptIn: readUsageOptIn(body) };
}

type UsageObserverKind = 'sse' | 'json' | 'none';

function usageObserverKind(contentType: string | undefined): UsageObserverKind {
  if (contentType === undefined) return 'none';
  if (contentType.includes('text/event-stream')) return 'sse';
  if (contentType.includes('application/json')) return 'json';
  return 'none';
}

/** Passively folds upstream usage out of the proxied bytes; gives up once its bounded buffer fills. */
class PassthroughUsageObserver {
  private readonly decoder = new StringDecoder('utf8');
  private readonly parser = new SseFrameParser();
  private jsonText = '';
  private abandoned = false;
  private fold: InferenceThroughput | null = null;

  private readonly kind: UsageObserverKind;

  constructor(kind: UsageObserverKind) {
    this.kind = kind;
  }

  push(chunk: Buffer): void {
    if (this.abandoned || this.kind === 'none') return;
    const text = this.decoder.write(chunk);
    if (this.kind === 'json') {
      this.jsonText += text;
      this.abandoned = this.jsonText.length > JSON_OBSERVE_LIMIT_CHARS;
      return;
    }
    for (const frame of this.parser.push(text)) {
      if (frame.data.length > SSE_OBSERVE_LIMIT_CHARS) {
        this.abandoned = true;
        return;
      }
      if (frame.data.includes('"usage"')) this.observe(frame.data);
    }
    this.abandoned = this.parser.pendingLength > SSE_OBSERVE_LIMIT_CHARS;
  }

  private observe(text: string): void {
    let body: JsonValue;
    try {
      body = parseJsonValueText(text);
    } catch {
      return;
    }
    if (isJsonObject(body) && body.usage !== undefined) {
      this.fold = observeTabbyThroughput(this.fold ?? emptyInferenceThroughput(), body);
    }
  }

  /** The fold to audit: observed usage, unmeasured when the caller expected usage, else null. */
  finish(usageOptIn: boolean): InferenceThroughput | null {
    if (this.abandoned) return null;
    if (this.kind === 'json') {
      try {
        return readTabbyThroughput(parseJsonValueText(this.jsonText + this.decoder.end()));
      } catch {
        return unmeasuredInferenceThroughput();
      }
    }
    return this.fold ?? (usageOptIn ? unmeasuredInferenceThroughput() : null);
  }
}

type PassthroughAudit = { identity: ThroughputAuditIdentity; usageOptIn: boolean };

async function proxyStreamingRequest(
  ctx: ServerContext,
  req: IncomingMessage,
  res: ServerResponse,
  baseUrl: string,
  upstreamPath: string,
  bodyText: string,
  audit: PassthroughAudit,
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
      const statusCode = upstreamResponse.statusCode || 502;
      const observer = new PassthroughUsageObserver(
        statusCode < 300 ? usageObserverKind(upstreamResponse.headers['content-type']) : 'none',
      );
      res.writeHead(statusCode, buildResponseHeaders(upstreamResponse.headers));
      upstreamResponse.on('data', (chunk: Buffer) => observer.push(chunk));
      upstreamResponse.pipe(res);
      upstreamResponse.on('end', () => {
        const fold = observer.finish(audit.usageOptIn);
        if (fold !== null) auditInferenceThroughput({ ...audit.identity, scope: 'request' }, fold, UNPUBLISHED_RATES);
        resolve();
      });
      upstreamResponse.on('error', reject);
    });
    upstream.on('error', reject);
    upstream.setTimeout(CHAT_TIMEOUT_MS, () => upstream.destroy(new Error('Inference passthrough timed out.')));
    const abortUpstream = () => upstream.destroy(new Error('Downstream inference request aborted.'));
    req.on('aborted', abortUpstream);
    res.on('close', () => {
      if (!res.writableFinished) abortUpstream();
    });
    upstream.end(bodyText);
  });
}

async function proxyTokenizeRequest(res: ServerResponse, target: TokenEncodeTarget, text: string): Promise<void> {
  const response = await inferenceClient.postTokenEncode(target, { text });
  if (response.statusCode >= 400) {
    res.writeHead(response.statusCode, { 'content-type': 'application/json' });
    res.end(response.rawText);
    return;
  }
  sendJson(res, 200, TabbyTokenEncodeResponseSchema.parse(response.body));
}

// Deliberately no-wake. It reports the configured preset because that is the preset a
// following workload request routes to, even while the runtime still holds another one.
class ModelsEndpoint implements RouteEndpoint {
  async handle(ctx: ServerContext, _req: IncomingMessage, res: ServerResponse): Promise<void> {
    const config = readConfig(ctx.configPath);
    sendJson(res, 200, { data: [{ id: getConfiguredModel(config), object: 'model' }] });
  }
}

class WorkloadEndpoint implements RouteEndpoint {
  async handle(ctx: ServerContext, req: IncomingMessage, res: ServerResponse, match: RouteMatch): Promise<void> {
    let chatBody: PassthroughChatBody | null = null;
    let tokenizeText: string | null = null;
    try {
      const bodyText = await readBody(req);
      if (match.pathname === CHAT_PATH) chatBody = parseRequestBody(bodyText, PassthroughChatBodySchema);
      else tokenizeText = parseRequestBody(bodyText, TokenizeRequestSchema).text;
    } catch (error) {
      sendBodyReadError(res, toError(error), { error: error instanceof Error ? error.message : String(error) });
      return;
    }
    let lock: ModelRequestLock | null;
    try {
      lock = await acquireModelRequestWithWait(ctx, 'inference_passthrough', req, res);
    } catch (error) {
      // Admission readies the model before granting; a failed load answers like any upstream failure.
      sendJson(res, 502, { error: toError(error).message });
      return;
    }
    if (!lock) return;
    try {
      // Forward to the model admission granted, not whatever the config names now.
      const { modelPreset: currentPreset } = lock.context;
      const baseUrl = currentPreset.BaseUrl;
      if (!baseUrl) {
        sendJson(res, 503, { error: 'The active preset BaseUrl is not configured.' });
        return;
      }
      const target = { baseUrl, authorization: req.headers.authorization };
      if (chatBody !== null) {
        const translated = await translateChatBody(chatBody, currentPreset, ctx.passthroughPromptCounter, target);
        const passthroughId = randomUUID();
        serverLogger.event({
          scope: 'proxy',
          id: passthroughId,
          event: 'forward',
          fields: `path=${CHAT_PATH} base_url=${baseUrl} `
            + `messages=${chatBody.messages.length} body_chars=${translated.text.length}`,
        });
        await proxyStreamingRequest(ctx, req, res, baseUrl, CHAT_PATH, translated.text, {
          identity: {
            operationType: 'passthrough',
            operationId: passthroughId,
            requestId: passthroughId,
            stage: 'chat_completions',
            model: currentPreset.Model ?? currentPreset.id,
            presetId: currentPreset.id,
          },
          usageOptIn: translated.usageOptIn,
        });
      } else if (tokenizeText !== null) {
        await proxyTokenizeRequest(res, target, tokenizeText);
      }
      ctx.idleSummary.pending = true;
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
  { method: 'POST', path: TABBY_TOKEN_ENCODE_PATH, endpoint: new WorkloadEndpoint() },
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

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
import type { ModelRuntimePreset, SiftConfig } from '../../config/types.js';
import { getConfiguredModel } from '../../config/getters.js';
import { isJsonObject, type JsonObject, type JsonValue } from '../../lib/json-types.js';
import { parseJsonValueText } from '../../lib/json.js';
import { httpClient } from '../../lib/http-client.js';
import { SseFrameParser } from '../../lib/sse-frame-parser.js';
import {
  emptyInferenceThroughput,
  observeTabbyThroughput,
  readTabbyThroughput,
  unmeasuredInferenceThroughput,
} from '../../lib/inference-throughput.js';
import { auditInferenceThroughput, UNPUBLISHED_RATES } from '../inference-throughput-audit.js';
import { buildPresetRequestDefaults } from '../../inference-presets/preset-compatibility.js';
import { resolveGenerationTokenLimit } from '../../lib/context-token-budget.js';
import { estimateTokenCount } from '../../lib/token-estimate.js';
import { INFERENCE_REQUEST_COMPATIBILITY } from '../../inference-presets/preset-compatibility.js';
import { readConfig } from '../config-store.js';
import { serverLogger } from '../server-logger.js';
import { toError } from '../../lib/errors.js';
import { readBody, sendBodyReadError, sendJson } from '../http-utils.js';
import { RouteTable, type RouteEndpoint, type RouteMatch } from '../route-table.js';
import {
  acquireModelRequestWithWait,
  releaseModelRequest,
} from '../server-ops.js';
import type { ModelRequestLock, ServerContext } from '../server-types.js';

const CHAT_PATH = '/v1/chat/completions';
const MODELS_PATH = '/v1/models';
const EXL3_TOKENIZE_PATH = '/v1/token/encode';
const CHAT_TIMEOUT_MS = 600_000;
const TOKENIZE_TIMEOUT_MS = 60_000;
const SSE_OBSERVE_LIMIT_CHARS = 256 * 1024;
const JSON_OBSERVE_LIMIT_CHARS = 4 * 1024 * 1024;
const HOP_BY_HOP_RESPONSE_HEADERS = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade',
]);

function isInferencePath(pathname: string): boolean {
  return pathname === MODELS_PATH
    || pathname === CHAT_PATH
    || pathname === EXL3_TOKENIZE_PATH;
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
function applyThinkingSettings(body: JsonObject, preset: ModelRuntimePreset): void {
  const compatibility = INFERENCE_REQUEST_COMPATIBILITY;
  const thinkingEnabled = preset.Reasoning === 'on';
  const reasoningContent = thinkingEnabled && preset.ReasoningContent;
  body.chat_template_kwargs = {
    enable_thinking: thinkingEnabled,
    ...(compatibility.reasoningContent && reasoningContent ? { reasoning_content: true } : {}),
    ...(reasoningContent && preset.PreserveThinking ? { preserve_thinking: true } : {}),
    ...(thinkingEnabled ? { reasoning_effort: preset.ReasoningEffort } : {}),
  };
}

function validateChatBody(bodyText: string): number {
  const parsed = parseJsonValueText(bodyText);
  if (!isJsonObject(parsed) || !Array.isArray(parsed.messages)) {
    throw new Error('Expected a JSON object with a messages array.');
  }
  return parsed.messages.length;
}

type TranslatedChatBody = { text: string; usageOptIn: boolean };

/** A caller expects usage on a non-streaming response or when it asked for a usage frame. */
function readUsageOptIn(body: JsonObject): boolean {
  if (body.stream !== true) return true;
  return isJsonObject(body.stream_options) && body.stream_options.include_usage === true;
}

function translateChatBody(bodyText: string, preset: ModelRuntimePreset, config: SiftConfig): TranslatedChatBody {
  const parsed = parseJsonValueText(bodyText);
  if (!isJsonObject(parsed) || !Array.isArray(parsed.messages)) {
    throw new Error('Expected a JSON object with a messages array.');
  }
  const defaults = buildPresetRequestDefaults(preset);
  parsed.model = preset.Model ?? preset.id;
  // The preset is authoritative for sampling; a caller may only lower the ceiling the
  // context leaves once this prompt is accounted for. A passthrough caller supplies no
  // measured count, so the prompt is priced with the local estimate.
  parsed.max_tokens = resolveGenerationTokenLimit({
    totalContextTokens: preset.NumCtx,
    promptTokenCount: estimateTokenCount(config, JSON.stringify(parsed.messages)),
    operationMaxTokens: typeof parsed.max_tokens === 'number'
      && Number.isInteger(parsed.max_tokens)
      && parsed.max_tokens >= 1
      ? parsed.max_tokens
      : undefined,
  });
  parsed.temperature = defaults.temperature;
  parsed.top_p = defaults.topP;
  parsed.top_k = defaults.topK;
  parsed.min_p = defaults.minP;
  parsed.presence_penalty = defaults.presencePenalty;
  applyThinkingSettings(parsed, preset);
  const compatibility = INFERENCE_REQUEST_COMPATIBILITY;
  parsed[compatibility.repetitionPenaltyKey] = defaults.repetitionPenalty;
  return { text: JSON.stringify(parsed), usageOptIn: readUsageOptIn(parsed) };
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

  constructor(private readonly kind: UsageObserverKind) {}

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

function readTokenizeText(bodyText: string): string {
  const parsed = parseJsonValueText(bodyText);
  if (!isJsonObject(parsed)) throw new Error('Expected a JSON object.');
  const text = parsed.text;
  if (typeof text !== 'string') throw new Error("Expected 'text' to be a string.");
  return text;
}

function getTokenArray(value: JsonValue): JsonValue[] | null {
  if (!isJsonObject(value) || !Array.isArray(value.tokens)) return null;
  return value.tokens;
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

async function proxyTokenizeRequest(
  req: IncomingMessage,
  res: ServerResponse,
  baseUrl: string,
  requestText: string,
): Promise<void> {
  const response = await fetch(new URL(EXL3_TOKENIZE_PATH, `${baseUrl.replace(/\/$/u, '')}/`), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(req.headers.authorization ? { authorization: req.headers.authorization } : {}),
    },
    body: JSON.stringify({ text: requestText }),
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
  if (!tokens) throw new Error('Upstream tokenization response did not contain a tokens array.');
  sendJson(res, 200, { tokens, length: tokens.length });
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
    let bodyText: string;
    let requestText: string | null = null;
    let chatMessageCount = 0;
    try {
      bodyText = await readBody(req);
      if (match.pathname === CHAT_PATH) chatMessageCount = validateChatBody(bodyText);
      else requestText = readTokenizeText(bodyText);
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
      const { config: currentConfig, modelPreset: currentPreset } = lock.context;
      const baseUrl = currentPreset.BaseUrl;
      if (!baseUrl) {
        sendJson(res, 503, { error: 'The active preset BaseUrl is not configured.' });
        return;
      }
      if (match.pathname === CHAT_PATH) {
        const translated = translateChatBody(bodyText, currentPreset, currentConfig);
        const passthroughId = randomUUID();
        serverLogger.event({
          scope: 'proxy',
          id: passthroughId,
          event: 'forward',
          fields: `path=${CHAT_PATH} base_url=${baseUrl} `
            + `messages=${chatMessageCount} body_chars=${translated.text.length}`,
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
      } else if (requestText !== null) {
        await proxyTokenizeRequest(req, res, baseUrl, requestText);
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

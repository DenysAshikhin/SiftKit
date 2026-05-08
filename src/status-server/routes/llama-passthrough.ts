import * as http from 'node:http';
import * as https from 'node:https';
import { getLlamaBaseUrl, getManagedLlamaConfig, readConfig } from '../config-store.js';
import { readBody, sendJson } from '../http-utils.js';
import {
  acquireModelRequestWithWait,
  ensureManagedLlamaReadyForModelRequest,
  releaseModelRequest,
} from '../server-ops.js';
import type { ServerContext } from '../server-types.js';
import type { Dict } from '../../lib/types.js';

const CHAT_COMPLETIONS_PATH = '/v1/chat/completions';
const MODELS_PATH = '/v1/models';
const CHAT_COMPLETIONS_TIMEOUT_MS = 600_000;
const HOP_BY_HOP_RESPONSE_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

function isLlamaPassthroughPath(pathname: string): boolean {
  return pathname === MODELS_PATH || pathname === CHAT_COMPLETIONS_PATH;
}

function isAllowedLlamaPassthroughMethod(pathname: string, method: string | undefined): boolean {
  const normalizedMethod = String(method || 'GET').toUpperCase();
  if (pathname === MODELS_PATH) {
    return normalizedMethod === 'GET';
  }
  return normalizedMethod === 'POST';
}

function getLlamaPassthroughKind(pathname: string): string {
  return pathname === MODELS_PATH ? 'llama_passthrough_models' : 'llama_passthrough_chat';
}

function buildUpstreamUrl(baseUrl: string, requestUrl: string | undefined): URL {
  const routeUrl = new URL(requestUrl || '/', 'http://127.0.0.1');
  return new URL(`${baseUrl.replace(/\/$/u, '')}${routeUrl.pathname}${routeUrl.search}`);
}

function getOrigin(urlText: string): string {
  const parsed = new URL(urlText);
  return parsed.origin;
}

function isSelfPassthroughBaseUrl(ctx: ServerContext, baseUrl: string): boolean {
  return getOrigin(baseUrl) === getOrigin(ctx.getServiceBaseUrl());
}

function buildUpstreamRequestHeaders(req: http.IncomingMessage, bodyText: string): http.OutgoingHttpHeaders {
  const headers: http.OutgoingHttpHeaders = {};
  const contentType = req.headers['content-type'];
  const accept = req.headers.accept;
  const authorization = req.headers.authorization;
  if (contentType) {
    headers['content-type'] = contentType;
  }
  if (accept) {
    headers.accept = accept;
  }
  if (authorization) {
    headers.authorization = authorization;
  }
  if (bodyText) {
    headers['content-length'] = Buffer.byteLength(bodyText, 'utf8');
  }
  return headers;
}

function buildDownstreamResponseHeaders(headers: http.IncomingHttpHeaders): http.OutgoingHttpHeaders {
  const downstreamHeaders: http.OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined || HOP_BY_HOP_RESPONSE_HEADERS.has(name.toLowerCase())) {
      continue;
    }
    downstreamHeaders[name] = value;
  }
  return downstreamHeaders;
}

function getPassthroughTimeoutMs(pathname: string, config: Dict): number {
  if (pathname === MODELS_PATH) {
    return getManagedLlamaConfig(config).HealthcheckTimeoutMs;
  }
  return CHAT_COMPLETIONS_TIMEOUT_MS;
}

async function proxyLlamaRequest(
  ctx: ServerContext,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pathname: string,
  config: Dict,
): Promise<void> {
  const baseUrl = getLlamaBaseUrl(config);
  if (!baseUrl) {
    sendJson(res, 503, { error: 'llama.cpp base URL is not configured.' });
    return;
  }
  if (isSelfPassthroughBaseUrl(ctx, baseUrl)) {
    sendJson(res, 500, { error: 'Server.LlamaCpp.BaseUrl points at the SiftKit passthrough server.' });
    return;
  }
  const bodyText = pathname === CHAT_COMPLETIONS_PATH ? await readBody(req) : '';
  const upstreamUrl = buildUpstreamUrl(baseUrl, req.url);
  const transport = upstreamUrl.protocol === 'https:' ? https : http;
  const timeoutMs = getPassthroughTimeoutMs(pathname, config);
  await new Promise<void>((resolve, reject) => {
    const upstreamRequest = transport.request(
      {
        protocol: upstreamUrl.protocol,
        hostname: upstreamUrl.hostname,
        port: upstreamUrl.port || (upstreamUrl.protocol === 'https:' ? 443 : 80),
        path: `${upstreamUrl.pathname}${upstreamUrl.search}`,
        method: req.method || 'GET',
        headers: buildUpstreamRequestHeaders(req, bodyText),
      },
      (upstreamResponse) => {
        res.writeHead(
          upstreamResponse.statusCode || 502,
          buildDownstreamResponseHeaders(upstreamResponse.headers),
        );
        upstreamResponse.pipe(res);
        upstreamResponse.on('end', resolve);
        upstreamResponse.on('error', reject);
      },
    );
    upstreamRequest.on('error', reject);
    upstreamRequest.setTimeout(timeoutMs, () => {
      upstreamRequest.destroy(new Error(`llama.cpp passthrough timed out after ${timeoutMs} ms.`));
    });
    req.on('aborted', () => {
      upstreamRequest.destroy(new Error('Downstream llama passthrough request aborted.'));
    });
    if (bodyText) {
      upstreamRequest.write(bodyText);
    }
    upstreamRequest.end();
  });
}

export async function handleLlamaPassthroughRoute(
  ctx: ServerContext,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pathname: string,
): Promise<boolean> {
  if (!isLlamaPassthroughPath(pathname)) {
    return false;
  }
  if (!isAllowedLlamaPassthroughMethod(pathname, req.method)) {
    sendJson(res, 405, { error: 'Method not allowed.' });
    return true;
  }
  const modelRequestLock = await acquireModelRequestWithWait(ctx, getLlamaPassthroughKind(pathname), req, res);
  if (!modelRequestLock) {
    return true;
  }
  try {
    try {
      await ensureManagedLlamaReadyForModelRequest(ctx);
    } catch (error) {
      sendJson(res, 503, { error: error instanceof Error ? error.message : String(error) });
      return true;
    }
    await proxyLlamaRequest(ctx, req, res, pathname, readConfig(ctx.configPath));
  } catch (error) {
    if (!res.headersSent && !res.destroyed) {
      sendJson(res, 502, { error: error instanceof Error ? error.message : String(error) });
    } else {
      res.destroy(error instanceof Error ? error : new Error(String(error)));
    }
  } finally {
    releaseModelRequest(ctx, modelRequestLock.token);
  }
  return true;
}

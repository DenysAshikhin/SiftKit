import { Agent as HttpAgent, request as httpRequest } from 'node:http';
import { Agent as HttpsAgent, request as httpsRequest } from 'node:https';
import { Agent as UndiciAgent, fetch as undiciFetch } from 'undici';
import { z } from './zod.js';
import { parseJsonObjectText, parseJsonText } from './json.js';
import type { JsonObject } from './json-types.js';
import { formatTimestamp } from './text-format.js';

export const CONNECT_TIMEOUT_MS = 20_000;
export const DEFAULT_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';
const DEFAULT_TIMEOUT_MS = 30_000;

export type HttpMethod = 'GET' | 'PUT' | 'POST' | 'DELETE';
export type HttpClientFetchInit = {
  method?: string;
  headers?: HeadersInit;
  body?: string | null;
  signal?: AbortSignal | null;
  redirect?: RequestRedirect;
  timeoutMs?: number;
};

export type RequestJsonOptions = {
  url: string;
  method: HttpMethod;
  timeoutMs?: number;
  body?: string;
  abortSignal?: AbortSignal;
  agent?: HttpAgent | HttpsAgent;
};

export type FullJsonResponse<T> = {
  statusCode: number;
  body: T;
  rawText: string;
};

export type TextResponse = { statusCode: number; body: string };

export type RequestTextOptions = {
  url: string;
  timeoutMs: number;
  agent?: HttpAgent | HttpsAgent;
};

export type SseStreamOptions = {
  url: string;
  body: string;
  timeoutMs?: number;
  abortSignal?: AbortSignal;
};

export type SseStreamResult = { sawDone: boolean };
export type SseStreamPacket = JsonObject;
export type SseStreamSignal = 'stop' | void;

export class LlamaHttpError extends Error {
  public readonly statusCode: number;
  public readonly rawText: string;

  constructor(statusCode: number, rawText: string) {
    super(`llama.cpp stream failed with HTTP ${statusCode}${rawText.trim() ? `: ${rawText.trim()}` : '.'}`);
    this.name = 'LlamaHttpError';
    this.statusCode = statusCode;
    this.rawText = rawText;
  }
}

export type LoggedHttpClientTask = 'repo-search' | 'summary' | 'command-output' | 'preset' | 'eval';

const httpAgent = new HttpAgent({ keepAlive: false, maxSockets: Infinity });
const httpsAgent = new HttpsAgent({ keepAlive: false, maxSockets: Infinity });
const externalAgent = new UndiciAgent({ connect: { timeout: CONNECT_TIMEOUT_MS } });

function getLoggedHttpClientTask(target: URL): LoggedHttpClientTask | null {
  if (target.pathname === '/repo-search') {
    return 'repo-search';
  }
  if (target.pathname === '/summary') {
    return 'summary';
  }
  if (target.pathname === '/command-output/analyze') {
    return 'command-output';
  }
  if (target.pathname === '/preset/run') {
    return 'preset';
  }
  if (target.pathname === '/eval/run') {
    return 'eval';
  }
  return null;
}

export function logHttpClientBoundary(task: LoggedHttpClientTask, event: string, fields: string = ''): void {
  if (process.env.SIFTKIT_HTTP_CLIENT_LOGS !== '1') {
    return;
  }
  process.stderr.write(`${formatTimestamp()} http_client ${event} task=${task}${fields ? ` ${fields}` : ''}\n`);
}

function logHttpClientLifecycle(target: URL, method: HttpMethod, event: string, fields: string): void {
  const task = getLoggedHttpClientTask(target);
  if (!task) {
    return;
  }
  const path = `${target.pathname}${target.search}`;
  logHttpClientBoundary(task, event, `method=${method} path=${path}${fields ? ` ${fields}` : ''}`);
}

function getAbortError(signal: AbortSignal | undefined, fallback: string): Error {
  return signal?.reason instanceof Error
    ? signal.reason
    : new Error(String(signal?.reason || fallback));
}

function getPositiveTimeoutMs(value: number | undefined, fallback: number): number {
  const numericValue = Number(value);
  return Number.isFinite(numericValue) && numericValue > 0
    ? Math.trunc(numericValue)
    : fallback;
}

function buildFetchHeaders(init: HttpClientFetchInit | undefined): Record<string, string> {
  const headers: Record<string, string> = {};
  const source = init?.headers;
  if (source instanceof Headers) {
    source.forEach((value, key) => {
      headers[key] = value;
    });
  } else if (Array.isArray(source)) {
    for (const [key, value] of source) {
      headers[String(key)] = String(value);
    }
  } else if (source && typeof source === 'object') {
    for (const [key, value] of Object.entries(source)) {
      if (value !== undefined) {
        headers[key] = String(value);
      }
    }
  }
  if (!Object.keys(headers).some((key) => key.toLowerCase() === 'user-agent')) {
    headers['User-Agent'] = DEFAULT_USER_AGENT;
  }
  return headers;
}

function buildFetchSignal(init: HttpClientFetchInit | undefined): AbortSignal {
  const timeoutSignal = AbortSignal.timeout(getPositiveTimeoutMs(init?.timeoutMs, DEFAULT_TIMEOUT_MS));
  return init?.signal ? AbortSignal.any([init.signal, timeoutSignal]) : timeoutSignal;
}

export class HttpClient {
  async fetch(url: string | URL, init?: HttpClientFetchInit): Promise<Response> {
    const { timeoutMs: _timeoutMs, ...requestInit } = init || {};
    const response = await undiciFetch(url, {
      ...requestInit,
      headers: buildFetchHeaders(init),
      signal: buildFetchSignal(init),
      dispatcher: externalAgent,
    });
    const headers: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      headers[key] = value;
    });
    return new Response(await response.arrayBuffer(), {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  }

  requestJson<T>(options: RequestJsonOptions, schema: z.ZodType<T>): Promise<T> {
    return requestJson<T>({ ...options, agent: options.agent ?? this.localAgent(options.url) }, schema);
  }

  requestJsonFull<T>(options: RequestJsonOptions, schema: z.ZodType<T>): Promise<FullJsonResponse<T>> {
    return requestJsonFull<T>({ ...options, agent: options.agent ?? this.localAgent(options.url) }, schema);
  }

  requestText(options: RequestTextOptions): Promise<TextResponse> {
    return requestText({ ...options, agent: options.agent ?? this.localAgent(options.url) });
  }

  streamSse(
    options: SseStreamOptions,
    onData: (packet: SseStreamPacket) => SseStreamSignal,
  ): Promise<SseStreamResult> {
    const target = new URL(options.url);
    const requestTransport = target.protocol === 'https:' ? httpsRequest : httpRequest;
    return new Promise<SseStreamResult>((resolve, reject) => {
      let settled = false;
      let sawDone = false;
      let stoppedEarly = false;
      const settleResolve = (): void => {
        if (settled) {
          return;
        }
        settled = true;
        options.abortSignal?.removeEventListener('abort', abortRequest);
        resolve({ sawDone });
      };
      const settleReject = (error: Error): void => {
        if (settled) {
          return;
        }
        settled = true;
        options.abortSignal?.removeEventListener('abort', abortRequest);
        reject(error);
      };
      const handleStreamClose = (error: Error): void => {
        if (stoppedEarly) {
          settleResolve();
          return;
        }
        if (options.abortSignal?.aborted) {
          settleReject(getAbortError(options.abortSignal, 'llama.cpp chat stream aborted.'));
          return;
        }
        if (sawDone) {
          settleResolve();
          return;
        }
        settleReject(error);
      };

      const request = requestTransport({
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port || (target.protocol === 'https:' ? 443 : 80),
        path: `${target.pathname}${target.search}`,
        method: 'POST',
        agent: this.localAgent(target),
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(options.body, 'utf8'),
        },
      }, (response) => {
        const statusCode = response.statusCode || 0;
        if (statusCode >= 400) {
          let body = '';
          response.setEncoding('utf8');
          response.on('data', (chunk: string) => { body += chunk; });
          response.on('end', () => { settleReject(new LlamaHttpError(statusCode, body)); });
          response.on('error', () => { settleReject(new LlamaHttpError(statusCode, body)); });
          return;
        }
        let rawBuffer = '';
        response.setEncoding('utf8');
        response.on('data', (chunk: string) => {
          rawBuffer += chunk;
          let boundary = rawBuffer.indexOf('\n\n');
          while (boundary >= 0) {
            const packet = rawBuffer.slice(0, boundary);
            rawBuffer = rawBuffer.slice(boundary + 2);
            boundary = rawBuffer.indexOf('\n\n');
            const dataLine = packet
              .split(/\r?\n/gu)
              .map((line) => line.trim())
              .filter(Boolean)
              .find((line) => line.startsWith('data:'));
            if (!dataLine) {
              continue;
            }
            const dataValue = dataLine.slice(5).trim();
            if (dataValue === '[DONE]') {
              sawDone = true;
              continue;
            }
            let parsed: SseStreamPacket;
            try {
              parsed = parseJsonObjectText(dataValue);
            } catch {
              continue;
            }
            if (onData(parsed) === 'stop') {
              stoppedEarly = true;
              request.destroy();
              settleResolve();
              return;
            }
          }
        });
        response.on('aborted', () => { handleStreamClose(new Error('llama.cpp chat stream reset before completion.')); });
        response.on('error', (error: Error) => { handleStreamClose(error); });
        response.on('end', settleResolve);
      });

      const timeoutMs = Number.isFinite(Number(options.timeoutMs)) && Number(options.timeoutMs) > 0
        ? Math.trunc(Number(options.timeoutMs))
        : 0;
      if (timeoutMs > 0) {
        request.setTimeout(timeoutMs, () => {
          request.destroy(new Error(`llama.cpp chat stream timed out after ${timeoutMs} ms.`));
        });
      }
      const abortRequest = (): void => {
        request.destroy(getAbortError(options.abortSignal, 'llama.cpp chat stream aborted.'));
      };
      request.on('error', (error: Error) => { handleStreamClose(error); });
      if (options.abortSignal?.aborted) {
        abortRequest();
      } else {
        options.abortSignal?.addEventListener('abort', abortRequest, { once: true });
      }
      request.write(options.body);
      request.end();
    });
  }

  localAgent(url: string | URL): HttpAgent | HttpsAgent {
    const target = typeof url === 'string' ? new URL(url) : url;
    return target.protocol === 'https:' ? httpsAgent : httpAgent;
  }
}

function requestJson<T>(options: RequestJsonOptions, schema: z.ZodType<T>): Promise<T> {
  const target = new URL(options.url);
  const requestTransport = target.protocol === 'https:' ? httpsRequest : httpRequest;
  const startedAt = Date.now();
  const bodyChars = options.body ? Buffer.byteLength(options.body, 'utf8') : 0;
  logHttpClientLifecycle(target, options.method, 'enqueue_intent', `body_chars=${bodyChars}`);
  return new Promise((resolve, reject) => {
    logHttpClientLifecycle(target, options.method, 'request_start', '');
    const request = requestTransport(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port || (target.protocol === 'https:' ? 443 : 80),
        path: `${target.pathname}${target.search}`,
        method: options.method,
        agent: options.agent,
        headers: options.body ? {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(options.body, 'utf8'),
        } : undefined,
      },
      (response) => {
        logHttpClientLifecycle(
          target,
          options.method,
          'response_received',
          `status=${response.statusCode || 0} elapsed_ms=${Math.max(0, Date.now() - startedAt)}`,
        );
        let responseText = '';
        response.setEncoding('utf8');
        response.on('data', (chunk: string) => {
          responseText += chunk;
        });
        response.on('end', () => {
          logHttpClientLifecycle(
            target,
            options.method,
            'response_done',
            `status=${response.statusCode || 0} response_chars=${Buffer.byteLength(responseText, 'utf8')} elapsed_ms=${Math.max(0, Date.now() - startedAt)}`,
          );
          if ((response.statusCode || 0) >= 400) {
            reject(new Error(`HTTP ${response.statusCode}: ${responseText}`));
            return;
          }

          if (!responseText.trim()) {
            resolve(parseJsonText<T>('{}', schema));
            return;
          }

          try {
            resolve(parseJsonText<T>(responseText, schema));
          } catch (error) {
            reject(error);
          }
        });
      }
    );

    if (Number.isFinite(Number(options.timeoutMs)) && Number(options.timeoutMs) > 0) {
      const timeoutMs = Math.trunc(Number(options.timeoutMs));
      request.setTimeout(timeoutMs, () => {
        request.destroy(new Error(`Request timed out after ${timeoutMs} ms.`));
      });
    }
    request.on('error', (error) => {
      logHttpClientLifecycle(
        target,
        options.method,
        'request_error',
        `elapsed_ms=${Math.max(0, Date.now() - startedAt)} error=${String(error.message || error).replace(/\s+/gu, '_')}`,
      );
      reject(error);
    });
    if (options.body) {
      request.write(options.body);
    }
    request.end();
    logHttpClientLifecycle(target, options.method, 'request_sent', `elapsed_ms=${Math.max(0, Date.now() - startedAt)}`);
  });
}

function requestText(options: RequestTextOptions): Promise<TextResponse> {
  return new Promise((resolve, reject) => {
    const target = new URL(options.url);
    const requestTransport = target.protocol === 'https:' ? httpsRequest : httpRequest;
    const request = requestTransport({
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port || (target.protocol === 'https:' ? 443 : 80),
      path: `${target.pathname}${target.search}`,
      method: 'GET',
      agent: options.agent,
    }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk: string) => { body += chunk; });
      response.on('end', () => {
        resolve({ statusCode: response.statusCode || 0, body });
      });
    });
    request.setTimeout(options.timeoutMs, () => {
      request.destroy(new Error(`Request timed out after ${options.timeoutMs} ms.`));
    });
    request.on('error', reject);
    request.end();
  });
}

function requestJsonFull<T>(options: RequestJsonOptions, schema: z.ZodType<T>): Promise<FullJsonResponse<T>> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timeoutHandle: NodeJS.Timeout | null = null;
    const resolveOnce = (value: FullJsonResponse<T>): void => {
      if (settled) return;
      settled = true;
      if (timeoutHandle) clearTimeout(timeoutHandle);
      options.abortSignal?.removeEventListener('abort', abortRequest);
      resolve(value);
    };
    const rejectOnce = (error: Error): void => {
      if (settled) return;
      settled = true;
      if (timeoutHandle) clearTimeout(timeoutHandle);
      options.abortSignal?.removeEventListener('abort', abortRequest);
      reject(error);
    };

    const target = new URL(options.url);
    const requestTransport = target.protocol === 'https:' ? httpsRequest : httpRequest;
    const request = requestTransport(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port || (target.protocol === 'https:' ? 443 : 80),
        path: `${target.pathname}${target.search}`,
        method: options.method,
        agent: options.agent,
        headers: options.body ? {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(options.body, 'utf8'),
        } : undefined,
      },
      (response) => {
        let responseText = '';
        response.setEncoding('utf8');
        response.on('data', (chunk: string) => {
          responseText += chunk;
        });
        response.on('end', () => {
          if (!responseText.trim()) {
            resolveOnce({ statusCode: response.statusCode || 0, body: parseJsonText<T>('{}', schema), rawText: '' });
            return;
          }
          try {
            resolveOnce({
              statusCode: response.statusCode || 0,
              body: parseJsonText<T>(responseText, schema),
              rawText: responseText,
            });
          } catch (error) {
            rejectOnce(error instanceof Error ? error : new Error(String(error)));
          }
        });
      },
    );

    if (Number.isFinite(Number(options.timeoutMs)) && Number(options.timeoutMs) > 0) {
      const timeoutMs = Math.trunc(Number(options.timeoutMs));
      timeoutHandle = setTimeout(() => {
        request.destroy(new Error(`Request timed out after ${timeoutMs} ms.`));
      }, timeoutMs);
    }
    const abortRequest = (): void => {
      request.destroy(getAbortError(options.abortSignal, 'Request aborted.'));
    };
    if (timeoutHandle && typeof timeoutHandle.unref === 'function') {
      timeoutHandle.unref();
    }

    if (options.abortSignal?.aborted) {
      abortRequest();
    } else {
      options.abortSignal?.addEventListener('abort', abortRequest, { once: true });
    }
    request.on('error', (error) => {
      rejectOnce(error);
    });
    if (options.body) {
      request.write(options.body);
    }
    request.end();
  });
}

export const httpClient = new HttpClient();

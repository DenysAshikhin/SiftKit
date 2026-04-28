import * as http from 'node:http';
import * as https from 'node:https';
import { parseJsonText } from './json.js';

export type HttpMethod = 'GET' | 'PUT' | 'POST' | 'DELETE';

export type RequestJsonOptions = {
  url: string;
  method: HttpMethod;
  timeoutMs: number;
  body?: string;
  abortSignal?: AbortSignal;
};

/**
 * Full HTTP response shape returned by {@link requestJsonFull}.
 * Includes the status code and raw text for callers that need to inspect
 * non-2xx responses without catching exceptions.
 */
export type FullJsonResponse<T> = {
  statusCode: number;
  body: T;
  rawText: string;
};

/**
 * Issues an HTTP(S) request and parses the response as JSON. Resolves `{}` for
 * empty bodies. Rejects on HTTP >=400 with the status code and raw body text.
 *
 * Shared primitive used by the CLI, config client, benchmark matrix, and
 * status-backend client — keep in sync with consumers that expect an error to
 * be thrown for non-2xx responses.
 */
export function requestJson<T>(options: RequestJsonOptions): Promise<T> {
  return new Promise((resolve, reject) => {
    const target = new URL(options.url);
    const transport = target.protocol === 'https:' ? https : http;
    const request = transport.request(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port || (target.protocol === 'https:' ? 443 : 80),
        path: `${target.pathname}${target.search}`,
        method: options.method,
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
          if ((response.statusCode || 0) >= 400) {
            reject(new Error(`HTTP ${response.statusCode}: ${responseText}`));
            return;
          }

          if (!responseText.trim()) {
            resolve({} as T);
            return;
          }

          try {
            resolve(parseJsonText<T>(responseText));
          } catch (error) {
            reject(error);
          }
        });
      }
    );

    request.setTimeout(options.timeoutMs, () => {
      request.destroy(new Error(`Request timed out after ${options.timeoutMs} ms.`));
    });
    request.on('error', reject);
    if (options.body) {
      request.write(options.body);
    }
    request.end();
  });
}

// ---------------------------------------------------------------------------
// Plain-text GET request (non-throwing, returns status code)
// ---------------------------------------------------------------------------

export type TextResponse = { statusCode: number; body: string };

export type RequestTextOptions = {
  url: string;
  timeoutMs: number;
};

export function requestText(options: RequestTextOptions): Promise<TextResponse> {
  return new Promise((resolve, reject) => {
    const target = new URL(options.url);
    const transport = target.protocol === 'https:' ? https : http;
    const request = transport.request({
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port || (target.protocol === 'https:' ? 443 : 80),
      path: `${target.pathname}${target.search}`,
      method: 'GET',
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

// ---------------------------------------------------------------------------
// JSON request (full response, non-throwing)
// ---------------------------------------------------------------------------

/**
 * Issues an HTTP(S) request and parses the response as JSON, returning the
 * full response including status code and raw text.  Unlike {@link requestJson}
 * this does **not** throw on non-2xx status codes — the caller decides how to
 * handle them.
 *
 * Shared primitive for providers and subsystems that need to inspect the
 * status code (e.g. llama.cpp provider, repo-search protocol).
 */
export function requestJsonFull<T>(options: RequestJsonOptions): Promise<FullJsonResponse<T>> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const resolveOnce = (value: FullJsonResponse<T>): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutHandle);
      options.abortSignal?.removeEventListener('abort', abortRequest);
      resolve(value);
    };
    const rejectOnce = (error: unknown): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutHandle);
      options.abortSignal?.removeEventListener('abort', abortRequest);
      reject(error);
    };
    const getAbortError = (): Error => (
      options.abortSignal?.reason instanceof Error
        ? options.abortSignal.reason
        : new Error(String(options.abortSignal?.reason || 'Request aborted.'))
    );

    const target = new URL(options.url);
    const transport = target.protocol === 'https:' ? https : http;
    const request = transport.request(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port || (target.protocol === 'https:' ? 443 : 80),
        path: `${target.pathname}${target.search}`,
        method: options.method,
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
            resolveOnce({ statusCode: response.statusCode || 0, body: {} as T, rawText: '' });
            return;
          }
          try {
            resolveOnce({
              statusCode: response.statusCode || 0,
              body: JSON.parse(responseText) as T,
              rawText: responseText,
            });
          } catch (error) {
            rejectOnce(error instanceof Error ? error : new Error(String(error)));
          }
        });
      },
    );

    const timeoutHandle = setTimeout(() => {
      request.destroy(new Error(`Request timed out after ${options.timeoutMs} ms.`));
    }, options.timeoutMs);
    const abortRequest = (): void => {
      request.destroy(getAbortError());
    };
    if (typeof timeoutHandle.unref === 'function') {
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

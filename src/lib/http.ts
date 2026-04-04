import * as http from 'node:http';
import * as https from 'node:https';
import { parseJsonText } from './json.js';

export type HttpMethod = 'GET' | 'PUT' | 'POST' | 'DELETE';

export type RequestJsonOptions = {
  url: string;
  method: HttpMethod;
  timeoutMs: number;
  body?: string;
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

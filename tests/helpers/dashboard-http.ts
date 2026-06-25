import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import type { AddressInfo } from 'node:net';

import { getErrorMessage } from '../../src/lib/errors.js';
import { parseJsonValueText } from '../../src/lib/json.js';
import { isJsonObject, type JsonObject, type JsonValue, type JsonSerializable, type OptionalJsonValue } from '../../src/lib/json-types.js';

export type Dict = JsonObject;
export type JsonResponse = { statusCode: number; body: Dict };
export type SseEvent = { event: string; payload: Dict | null };
export type SseResponse = { statusCode: number; events: SseEvent[] };
export type RequestOptions = { method?: string; body?: string; timeoutMs?: number };

// Narrowing helpers shared by the HTTP-driven E2E tests: every endpoint returns
// JSON, so response bodies and SSE payloads are JsonValue at the boundary and are
// narrowed here without casts.
export function asObject(value: OptionalJsonValue): Dict {
  return isJsonObject(value) ? value : {};
}

export function asArray(value: OptionalJsonValue): JsonValue[] {
  return Array.isArray(value) ? value : [];
}

export function asObjectArray(value: OptionalJsonValue): Dict[] {
  return asArray(value).map((entry) => asObject(entry));
}

export function getAddressInfo(server: { address(): string | AddressInfo | null }): AddressInfo {
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('server is not listening on a TCP port');
  }
  return address;
}

export function requestJson(url: string, options: RequestOptions = {}): Promise<JsonResponse> {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const request = http.request(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port,
        path: `${target.pathname}${target.search}`,
        method: options.method || 'GET',
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
          resolve({
            statusCode: response.statusCode || 0,
            body: responseText ? asObject(parseJsonValueText(responseText)) : {},
          });
        });
      },
    );
    request.on('error', reject);
    request.setTimeout(Number(options.timeoutMs || 4000), () => {
      request.destroy(new Error('request timeout'));
    });
    if (options.body) {
      request.write(options.body);
    }
    request.end();
  });
}

export function requestSse(url: string, options: RequestOptions = {}): Promise<SseResponse> {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const events: SseEvent[] = [];
    const request = http.request(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port,
        path: `${target.pathname}${target.search}`,
        method: options.method || 'GET',
        headers: options.body ? {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(options.body, 'utf8'),
        } : undefined,
      },
      (response) => {
        let buffer = '';
        response.setEncoding('utf8');
        response.on('data', (chunk: string) => {
          buffer += chunk;
          let boundary = buffer.indexOf('\n\n');
          while (boundary >= 0) {
            const packet = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary + 2);
            const lines = packet
              .split(/\r?\n/u)
              .map((line) => line.trim())
              .filter(Boolean);
            const eventLine = lines.find((line) => line.startsWith('event:'));
            const dataLine = lines.find((line) => line.startsWith('data:'));
            if (!dataLine) {
              boundary = buffer.indexOf('\n\n');
              continue;
            }
            const eventName = eventLine ? eventLine.slice(6).trim() : 'message';
            let payload: Dict | null = null;
            try {
              payload = asObject(parseJsonValueText(dataLine.slice(5).trim()));
            } catch {
              payload = null;
            }
            events.push({ event: eventName, payload });
            if (eventName === 'done' || eventName === 'error') {
              request.destroy();
              resolve({
                statusCode: response.statusCode || 0,
                events,
              });
              return;
            }
            boundary = buffer.indexOf('\n\n');
          }
        });
        response.on('error', reject);
        response.on('end', () => {
          resolve({
            statusCode: response.statusCode || 0,
            events,
          });
        });
      },
    );
    request.on('error', reject);
    request.setTimeout(Number(options.timeoutMs || 8000), () => {
      request.destroy(new Error('request timeout'));
    });
    if (options.body) {
      request.write(options.body);
    }
    request.end();
  });
}

export function fireAndAbortJsonRequest(url: string, body: string, abortAfterMs: number = 100): Promise<void> {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    let settled = false;
    let timer: NodeJS.Timeout | null = null;
    const finish = (error?: Error): void => {
      if (settled) {
        return;
      }
      settled = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      if (!error) {
        resolve();
        return;
      }
      const message = getErrorMessage(error);
      if (/aborted|hang up|econnreset/iu.test(message)) {
        resolve();
        return;
      }
      reject(error);
    };
    const request = http.request(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port,
        path: `${target.pathname}${target.search}`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body, 'utf8'),
        },
      },
      (response) => {
        response.resume();
        finish();
      },
    );
    request.on('error', (error) => finish(error));
    request.write(body);
    request.end();
    timer = setTimeout(() => {
      request.destroy(new Error('client aborted request'));
      finish();
    }, Math.max(1, Math.trunc(abortAfterMs)));
  });
}

export function writeJson(targetPath: string, payload: JsonSerializable): void {
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.writeFileSync(targetPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

export async function removeDirectoryWithRetries(targetPath: string, attempts: number = 40, delayMs: number = 100): Promise<void> {
  for (let index = 0; index < attempts; index += 1) {
    try {
      fs.rmSync(targetPath, { recursive: true, force: true });
      return;
    } catch {
      if (index === attempts - 1) {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

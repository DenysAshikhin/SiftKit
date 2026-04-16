import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';

export type Dict = Record<string, unknown>;
export type JsonResponse = { statusCode: number; body: Dict };
export type SseEvent = { event: string; payload: Dict | null };
export type SseResponse = { statusCode: number; events: SseEvent[] };
export type RequestOptions = { method?: string; body?: string; timeoutMs?: number };

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
            body: responseText ? JSON.parse(responseText) as Dict : {},
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
              payload = JSON.parse(dataLine.slice(5).trim()) as Dict;
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
    const finish = (error?: unknown): void => {
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
      const message = error instanceof Error ? error.message : String(error);
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

export function writeJson(targetPath: string, payload: unknown): void {
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

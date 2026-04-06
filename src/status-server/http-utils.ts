/**
 * HTTP helpers for the status-server.
 *
 * Filesystem utilities have been moved to `lib/fs.ts`; this file now contains
 * only HTTP client/server helpers and re-exports for backwards compatibility.
 */
import * as http from 'node:http';
import * as https from 'node:https';
import type { Dict } from '../lib/types.js';
import {
  ensureDirectory as ensureDirectoryShared,
  saveContentAtomically as saveContentAtomicallyShared,
  readTextIfExists as readTextIfExistsShared,
  listFiles as listFilesShared,
  writeText as writeTextShared,
  safeReadJson as safeReadJsonShared,
  getIsoDateFromStat as getIsoDateFromStatShared,
  sleep as sleepShared,
} from '../lib/fs.js';

// Re-export shared utilities so existing consumers don't need to change their
// import paths immediately.
export const ensureDirectory = ensureDirectoryShared;
export const saveContentAtomically = saveContentAtomicallyShared;
export const listFiles = listFilesShared;
export const writeText = writeTextShared;
export const safeReadJson = safeReadJsonShared;
export const getIsoDateFromStat = getIsoDateFromStatShared;
export const sleep = sleepShared;

/**
 * Reads a file as UTF-8 text, returning empty string if missing or unreadable.
 * (Wraps lib/fs readTextIfExists which returns null for missing files.)
 */
export function readTextIfExists(targetPath: string | null | undefined): string {
  if (!targetPath) {
    return '';
  }
  return readTextIfExistsShared(targetPath) ?? '';
}

// ---------------------------------------------------------------------------
// HTTP request helpers (status-server-specific API shapes)
// ---------------------------------------------------------------------------

export type TextResponse = { statusCode: number; body: string };
export type JsonResponse = { statusCode: number; body: unknown; rawText: string };
export type RequestJsonOptions = { method?: string; timeoutMs?: number; body?: string };

export function requestText(url: string, timeoutMs: number): Promise<TextResponse> {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
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
      response.on('data', (chunk: string) => {
        body += chunk;
      });
      response.on('end', () => {
        resolve({
          statusCode: response.statusCode || 0,
          body,
        });
      });
    });
    request.setTimeout(timeoutMs, () => {
      request.destroy(new Error(`Request timed out after ${timeoutMs} ms.`));
    });
    request.on('error', reject);
    request.end();
  });
}

export function requestJson(url: string, options: RequestJsonOptions = {}): Promise<JsonResponse> {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const transport = target.protocol === 'https:' ? https : http;
    const body = typeof options.body === 'string' ? options.body : '';
    const request = transport.request({
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port || (target.protocol === 'https:' ? 443 : 80),
      path: `${target.pathname}${target.search}`,
      method: options.method || 'GET',
      headers: body ? {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body, 'utf8'),
      } : undefined,
    }, (response) => {
      let responseText = '';
      response.setEncoding('utf8');
      response.on('data', (chunk: string) => {
        responseText += chunk;
      });
      response.on('end', () => {
        if (!responseText.trim()) {
          resolve({ statusCode: response.statusCode || 0, body: {}, rawText: '' });
          return;
        }
        try {
          resolve({
            statusCode: response.statusCode || 0,
            body: JSON.parse(responseText),
            rawText: responseText,
          });
        } catch (error) {
          reject(error);
        }
      });
    });
    request.setTimeout(Number(options.timeoutMs || 60000), () => {
      request.destroy(new Error(`Request timed out after ${Number(options.timeoutMs || 60000)} ms.`));
    });
    request.on('error', reject);
    if (body) {
      request.write(body);
    }
    request.end();
  });
}

// ---------------------------------------------------------------------------
// Server-specific helpers
// ---------------------------------------------------------------------------

export function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}

export function parseJsonBody(bodyText: string): Dict {
  if (!bodyText || !bodyText.trim()) {
    return {};
  }
  return JSON.parse(bodyText) as Dict;
}

export function sendJson(res: http.ServerResponse, statusCode: number, payload: unknown): void {
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
}

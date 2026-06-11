/**
 * HTTP server-side helpers for the status-server routes.
 *
 * Client-side HTTP helpers (requestJson, requestJsonFull, requestText) live
 * in `lib/http.ts`.  Filesystem utilities live in `lib/fs.ts`.
 */
import * as http from 'node:http';
import { JsonRecordReader } from '../lib/json-record-reader.js';
import type { JsonObject } from '../lib/json-types.js';

export function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}

export function parseJsonBody(bodyText: string): JsonObject {
  if (!bodyText || !bodyText.trim()) {
    return {};
  }
  const parsed = JSON.parse(bodyText) as unknown;
  const record = JsonRecordReader.asObject(parsed);
  if (!record) {
    throw new Error('Expected valid JSON object.');
  }
  return record;
}

export function sendJson(res: http.ServerResponse, statusCode: number, payload: unknown): void {
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
}

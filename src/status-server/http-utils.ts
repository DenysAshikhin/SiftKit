/**
 * HTTP server-side helpers for the status-server routes.
 *
 * Client-side HTTP helpers (requestJson, requestJsonFull, requestText) live
 * in `lib/http.ts`.  Filesystem utilities live in `lib/fs.ts`.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { JsonRecordReader } from '../lib/json-record-reader.js';
import { parseJsonValueText } from '../lib/json.js';
import type { JsonObject, JsonSerializable } from '../lib/json-types.js';

export function readBody(req: IncomingMessage): Promise<string> {
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
  const record = JsonRecordReader.asObject(parseJsonValueText(bodyText));
  if (!record) {
    throw new Error('Expected valid JSON object.');
  }
  return record;
}

export function sendJson(res: ServerResponse, statusCode: number, payload: JsonSerializable): void {
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
}

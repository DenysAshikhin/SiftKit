/**
 * HTTP server-side helpers for the status-server routes.
 *
 * Client-side HTTP helpers (requestJson, requestJsonFull, requestText) live
 * in `lib/http.ts`.  Filesystem utilities live in `lib/fs.ts`.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { JsonRecordReader } from '../lib/json-record-reader.js';
import { toError } from '../lib/errors.js';
import { parseJsonValueText } from '../lib/json.js';
import type { JsonObject, JsonSerializable } from '../lib/json-types.js';

/**
 * Default ceiling for a buffered request body. Summary input is legitimately
 * large, so this is a runaway-client backstop, not a product limit.
 */
const DEFAULT_MAX_REQUEST_BODY_BYTES = 256 * 1024 * 1024;

export class RequestBodyTooLargeError extends Error {
  readonly maxBytes: number;

  constructor(maxBytes: number) {
    super(`Request body exceeded the ${maxBytes} byte limit.`);
    this.name = 'RequestBodyTooLargeError';
    this.maxBytes = maxBytes;
  }
}

function getMaxRequestBodyBytes(override?: number): number {
  if (override !== undefined && Number.isFinite(override) && override > 0) {
    return Math.trunc(override);
  }
  const configured = Number(process.env.SIFTKIT_MAX_REQUEST_BODY_BYTES);
  if (Number.isFinite(configured) && configured > 0) {
    return Math.trunc(configured);
  }
  return DEFAULT_MAX_REQUEST_BODY_BYTES;
}

export function readBody(
  req: IncomingMessage,
  options: { maxBytes?: number } = {},
): Promise<string> {
  const maxBytes = getMaxRequestBodyBytes(options.maxBytes);
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    let settled = false;

    const cleanup = (): void => {
      req.off('data', onData);
      req.off('end', onEnd);
      req.off('aborted', onAborted);
      req.off('error', onError);
      req.off('close', onClose);
    };
    const settleResolve = (text: string): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(text);
    };
    const settleReject = (error: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      chunks.length = 0;
      reject(error);
    };

    const onData = (chunk: Buffer): void => {
      totalBytes += chunk.length;
      if (totalBytes > maxBytes) {
        settleReject(new RequestBodyTooLargeError(maxBytes));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = (): void => settleResolve(Buffer.concat(chunks).toString('utf8'));
    const onAborted = (): void => settleReject(new Error('Request aborted before the body was received.'));
    const onError = (error: Error): void => settleReject(error);
    const onClose = (): void => {
      // On a complete message 'end' already ran and the `settled` guard makes this
      // inert. On a mid-body disconnect 'end' never fires, and this is what stops
      // the promise hanging forever.
      if (req.complete) {
        return;
      }
      settleReject(new Error('Request closed before the body was received.'));
    };

    req.on('data', onData);
    req.on('end', onEnd);
    req.on('aborted', onAborted);
    req.on('error', onError);
    req.on('close', onClose);
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

/**
 * Shared classification for a failed body read. Oversize bodies get 413; every
 * other failure keeps the caller's existing 400 payload so route-specific error
 * shapes are preserved.
 */
export function sendBodyReadError(
  res: ServerResponse,
  error: Error,
  badRequestPayload: JsonSerializable,
): void {
  if (error instanceof RequestBodyTooLargeError) {
    sendJson(res, 413, { error: error.message });
    return;
  }
  sendJson(res, 400, badRequestPayload);
}

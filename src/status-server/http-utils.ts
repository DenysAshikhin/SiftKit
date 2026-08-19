/**
 * HTTP server-side helpers for the status-server routes.
 *
 * Client-side HTTP helpers (requestJson, requestJsonFull, requestText) live
 * in `lib/http.ts`.  Filesystem utilities live in `lib/fs.ts`.
 */
import fs from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { JsonRecordReader } from '../lib/json-record-reader.js';
import { parseJsonValueText } from '../lib/json.js';
import type { JsonObject, JsonSerializable } from '../lib/json-types.js';

/**
 * Ceiling for a buffered request body. Summary input is legitimately large, so
 * this is a runaway-client backstop, not a product limit. `options.maxBytes`
 * exists so tests can drive the 413 path without allocating 256 MB.
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

/**
 * The raw buffered body, backing `readBody`. Bodies that can be large go to disk via
 * `readBodyToFile` instead, which is why nothing outside this module buffers bytes directly.
 */
function readBodyBytes(
  req: IncomingMessage,
  options: { maxBytes?: number } = {},
): Promise<Buffer> {
  const maxBytes = Number.isFinite(options.maxBytes) && Number(options.maxBytes) > 0
    ? Math.trunc(Number(options.maxBytes))
    : DEFAULT_MAX_REQUEST_BODY_BYTES;
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
    const settleResolve = (bytes: Buffer): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(bytes);
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
    const onEnd = (): void => settleResolve(Buffer.concat(chunks));
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

export async function readBody(
  req: IncomingMessage,
  options: { maxBytes?: number } = {},
): Promise<string> {
  return (await readBodyBytes(req, options)).toString('utf8');
}

/**
 * Streams a request body straight to a file, enforcing the same byte ceiling as `readBodyBytes`
 * without ever holding the body. A rejected read leaves no file behind, so the caller's failure
 * path has nothing to remember. Used by §16.4 restore uploads, which are whole backups.
 */
export function readBodyToFile(
  req: IncomingMessage,
  destinationPath: string,
  options: { readonly maxBytes: number },
): Promise<void> {
  const maxBytes = Math.trunc(options.maxBytes);
  const fd = fs.openSync(destinationPath, 'w');
  return new Promise<void>((resolve, reject) => {
    let totalBytes = 0;
    let settled = false;

    const cleanup = (): void => {
      req.off('data', onData);
      req.off('end', onEnd);
      req.off('aborted', onAborted);
      req.off('error', onError);
      req.off('close', onClose);
      fs.closeSync(fd);
    };
    const settleResolve = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    };
    const settleReject = (error: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      fs.rmSync(destinationPath, { force: true });
      reject(error);
    };

    const onData = (chunk: Buffer): void => {
      totalBytes += chunk.byteLength;
      if (totalBytes > maxBytes) {
        settleReject(new RequestBodyTooLargeError(maxBytes));
        req.destroy();
        return;
      }
      try {
        fs.writeSync(fd, chunk, 0, chunk.byteLength, totalBytes - chunk.byteLength);
      } catch (error) {
        settleReject(error instanceof Error ? error : new Error(String(error)));
        req.destroy();
      }
    };
    const onEnd = (): void => settleResolve();
    const onAborted = (): void => settleReject(new Error('Request aborted before the body was received.'));
    const onError = (error: Error): void => settleReject(error);
    // Mirrors `readBodyBytes`: on a mid-body disconnect 'end' never fires, and this is what
    // stops the promise hanging forever.
    const onClose = (): void => {
      if (req.complete) return;
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

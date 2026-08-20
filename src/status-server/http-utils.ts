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
 * Where a streamed request body goes. Exactly one of `close` (body complete and accepted) or
 * `discard` (read failed) runs, so a sink that holds an fd or a temp file always releases it.
 */
interface BodySink {
  write(chunk: Buffer): void;
  close(): void;
  discard(): void;
}

/** Collects the body in memory for `readBody`. */
class BufferBodySink implements BodySink {
  private readonly chunks: Buffer[] = [];
  private collected: Buffer | null = null;

  write(chunk: Buffer): void {
    this.chunks.push(chunk);
  }

  close(): void {
    this.collected = Buffer.concat(this.chunks);
    this.chunks.length = 0;
  }

  discard(): void {
    this.chunks.length = 0;
  }

  take(): Buffer {
    if (this.collected === null) {
      throw new Error('Request body was not collected.');
    }
    return this.collected;
  }
}

/** Writes the body straight to disk, leaving nothing behind when the read fails. */
class FileBodySink implements BodySink {
  private readonly fd: number;
  private written = 0;

  constructor(private readonly destinationPath: string) {
    this.fd = fs.openSync(destinationPath, 'w');
  }

  write(chunk: Buffer): void {
    fs.writeSync(this.fd, chunk, 0, chunk.byteLength, this.written);
    this.written += chunk.byteLength;
  }

  close(): void {
    fs.closeSync(this.fd);
  }

  discard(): void {
    fs.closeSync(this.fd);
    fs.rmSync(this.destinationPath, { force: true });
  }
}

/**
 * The one body-reading loop. Oversize bodies reject with `RequestBodyTooLargeError`; a mid-body
 * disconnect rejects rather than hanging, because `end` never fires and only `close` is left to
 * settle the promise. The sink decides where the bytes land.
 */
function consumeBody(req: IncomingMessage, maxBytes: number, sink: BodySink): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let totalBytes = 0;
    let settled = false;

    const detach = (): void => {
      req.off('data', onData);
      req.off('end', onEnd);
      req.off('aborted', onAborted);
      req.off('error', onError);
      req.off('close', onClose);
    };
    const settleResolve = (): void => {
      if (settled) return;
      settled = true;
      detach();
      sink.close();
      resolve();
    };
    const settleReject = (error: Error): void => {
      if (settled) return;
      settled = true;
      detach();
      sink.discard();
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
        sink.write(chunk);
      } catch (error) {
        settleReject(error instanceof Error ? error : new Error(String(error)));
        req.destroy();
      }
    };
    const onEnd = (): void => settleResolve();
    const onAborted = (): void => settleReject(new Error('Request aborted before the body was received.'));
    const onError = (error: Error): void => settleReject(error);
    const onClose = (): void => {
      // On a complete message 'end' already ran and the `settled` guard makes this inert. On a
      // mid-body disconnect 'end' never fires, and this is what stops the promise hanging forever.
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

function resolveMaxBytes(maxBytes: number | undefined): number {
  return Number.isFinite(maxBytes) && Number(maxBytes) > 0
    ? Math.trunc(Number(maxBytes))
    : DEFAULT_MAX_REQUEST_BODY_BYTES;
}

export async function readBody(
  req: IncomingMessage,
  options: { maxBytes?: number } = {},
): Promise<string> {
  const sink = new BufferBodySink();
  await consumeBody(req, resolveMaxBytes(options.maxBytes), sink);
  return sink.take().toString('utf8');
}

/**
 * Streams a request body straight to a file, enforcing the same byte ceiling as `readBody` without
 * ever holding the body. A rejected read leaves no file behind, so the caller's failure path has
 * nothing to remember. Used by §16.4 restore uploads, which are whole backups.
 */
export function readBodyToFile(
  req: IncomingMessage,
  destinationPath: string,
  options: { readonly maxBytes: number },
): Promise<void> {
  return consumeBody(req, resolveMaxBytes(options.maxBytes), new FileBodySink(destinationPath));
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

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { JsonObject, JsonSerializable } from '../../lib/json-types.js';
import { OPERATION_STREAM_EVENTS } from '../../lib/operation-stream.js';
import { recordServerError } from '../error-response.js';
import { parseJsonBody, readBody, sendJson } from '../http-utils.js';
import { type RouteEndpoint, type RouteMatch } from '../route-table.js';
import {
  acquireModelRequestWithWait,
  ensureActivePresetReadyForModelRequest,
  getModelRequestQueueDiagnostics,
  releaseModelRequest,
} from '../server-ops.js';
import type { ServerContext } from '../server-types.js';
import { SseResponseWriter } from '../sse-response-writer.js';

const LOCK_WAIT_EMIT_INTERVAL_MS = 2_000;

export type ParsedStreamedRequest<TParsed> =
  | { ok: true; value: TParsed }
  | { ok: false; error: string };

export type StreamedOperationStream = {
  emitProgress(event: JsonSerializable): void;
  abortSignal: AbortSignal;
};

/** Runs validation, lock admission, execution, and terminal SSE framing. */
export abstract class StreamedOperationEndpoint<TParsed> implements RouteEndpoint {
  protected abstract readonly lockKind: string;
  protected abstract readonly taskKind: 'summary' | 'repo-search';

  protected abstract parseRequest(
    parsedBody: JsonObject,
    ctx: ServerContext,
  ): ParsedStreamedRequest<TParsed>;

  protected abstract execute(
    ctx: ServerContext,
    parsed: TParsed,
    stream: StreamedOperationStream,
  ): Promise<JsonSerializable>;

  protected onOperationFailed(_parsed: TParsed, _errorMessage: string): void {}

  async handle(
    ctx: ServerContext,
    req: IncomingMessage,
    res: ServerResponse,
    _match: RouteMatch,
  ): Promise<void> {
    let parsedBody: JsonObject;
    try {
      parsedBody = parseJsonBody(await readBody(req));
    } catch {
      sendJson(res, 400, { error: 'Expected valid JSON object.' });
      return;
    }
    const parsed = this.parseRequest(parsedBody, ctx);
    if (!parsed.ok) {
      sendJson(res, 400, { error: parsed.error });
      return;
    }

    const writer = new SseResponseWriter(req, res);
    writer.open();
    const abortController = new AbortController();
    let terminalFrameSent = false;
    res.on('close', () => {
      if (!terminalFrameSent) {
        abortController.abort(new Error('Client disconnected.'));
      }
    });

    const lockWaitStartedAt = Date.now();
    const lockWaitTimer = setInterval(() => {
      writer.writeEvent(OPERATION_STREAM_EVENTS.progress, {
        kind: 'lock_wait',
        queueLength: getModelRequestQueueDiagnostics(ctx).queueLength,
        elapsedMs: Date.now() - lockWaitStartedAt,
      });
    }, LOCK_WAIT_EMIT_INTERVAL_MS);
    lockWaitTimer.unref();
    const modelRequestLock = await acquireModelRequestWithWait(ctx, this.lockKind, req, res);
    clearInterval(lockWaitTimer);
    if (!modelRequestLock) {
      const message = 'Timed out waiting for model request queue.';
      this.onOperationFailed(parsed.value, message);
      terminalFrameSent = true;
      writer.writeEvent(OPERATION_STREAM_EVENTS.error, {
        message,
        modelRequests: getModelRequestQueueDiagnostics(ctx),
      });
      writer.end();
      return;
    }

    try {
      try {
        await ensureActivePresetReadyForModelRequest(ctx);
      } catch (error) {
        const payload = recordServerError(req, 503, error, { taskKind: this.taskKind });
        this.onOperationFailed(parsed.value, payload.error);
        terminalFrameSent = true;
        writer.writeEvent(OPERATION_STREAM_EVENTS.error, {
          message: payload.error,
          diagnosticId: payload.diagnosticId,
        });
        return;
      }
      const result = await this.execute(ctx, parsed.value, {
        emitProgress: (event) => writer.writeEvent(OPERATION_STREAM_EVENTS.progress, event),
        abortSignal: abortController.signal,
      });
      terminalFrameSent = true;
      writer.writeEvent(OPERATION_STREAM_EVENTS.result, result);
    } catch (error) {
      const payload = recordServerError(req, 500, error, { taskKind: this.taskKind });
      this.onOperationFailed(parsed.value, payload.error);
      terminalFrameSent = true;
      writer.writeEvent(OPERATION_STREAM_EVENTS.error, {
        message: payload.error,
        diagnosticId: payload.diagnosticId,
      });
    } finally {
      releaseModelRequest(ctx, modelRequestLock.token);
      writer.end();
    }
  }
}

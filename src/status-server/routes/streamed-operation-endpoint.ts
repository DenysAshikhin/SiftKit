import type { IncomingMessage, ServerResponse } from 'node:http';
import type { JsonObject, JsonSerializable } from '../../lib/json-types.ts';
import { OPERATION_STREAM_EVENTS } from '@siftkit/contracts';
import { recordServerError } from '../error-response.ts';
import { toError } from '../../lib/errors.ts';
import { parseJsonBody, readBody, sendBodyReadError, sendJson } from '../http-utils.ts';
import { type RouteEndpoint, type RouteMatch } from '../route-table.ts';
import {
  MODEL_QUEUE_TIMEOUT_MESSAGE,
  ModelRequestTargetError,
  acquireModelRequestWithWait,
  getModelRequestQueueDiagnostics,
  previewModelRequestTarget,
  releaseModelRequest,
} from '../server-ops.ts';
import type { ModelRequestContext } from '../model-request-context.ts';
import type { ModelRequestIntent } from '../../lib/model-request-intent.ts';
import type { ModelRequestLock, ServerContext } from '../server-types.ts';
import { SseResponseWriter } from '../sse-response-writer.ts';
import { rejectNestedAgentSelfCall } from '../nested-agent-call-guard.ts';

const DEFAULT_LOCK_WAIT_EMIT_INTERVAL_MS = 2_000;

// An unparseable override must not become the interval: setInterval clamps NaN to 1ms,
// which would flood every stream with lock_wait frames instead of pacing them.
function readLockWaitEmitIntervalMs(): number {
  const parsed = Number.parseInt(String(process.env.SIFTKIT_LOCK_WAIT_EMIT_INTERVAL_MS || ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_LOCK_WAIT_EMIT_INTERVAL_MS;
}

export type ParsedStreamedRequest<TParsed> =
  | { ok: true; value: TParsed }
  | { ok: false; error: string };

export class StreamedOperationContext {
  private readonly writer: SseResponseWriter;
  public readonly abortSignal: AbortSignal;
  /** The admitted snapshot: execution runs on exactly this operation preset, model, and config. */
  public readonly model: ModelRequestContext;

  constructor(
    writer: SseResponseWriter,
    abortSignal: AbortSignal,
    model: ModelRequestContext,
  ) {
    this.writer = writer;
    this.abortSignal = abortSignal;
    this.model = model;
  }

  writeProgress(event: JsonSerializable): void {
    this.writer.writeEvent(OPERATION_STREAM_EVENTS.progress, event);
  }
}

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
    stream: StreamedOperationContext,
  ): Promise<JsonSerializable>;

  /** The operation preset and CLI model this request asks for, resolved to a model at admission. */
  protected abstract modelIntent(parsed: TParsed, ctx: ServerContext): ModelRequestIntent;

  protected onOperationFailed(_parsed: TParsed, _errorMessage: string): void {}
  protected lockOwnerRunId(_parsed: TParsed): string | null {
    return null;
  }

  async handle(
    ctx: ServerContext,
    req: IncomingMessage,
    res: ServerResponse,
    _match: RouteMatch,
  ): Promise<void> {
    let parsedBody: JsonObject;
    try {
      parsedBody = parseJsonBody(await readBody(req));
    } catch (error) {
      sendBodyReadError(res, toError(error), { error: 'Expected valid JSON object.' });
      return;
    }
    if (rejectNestedAgentSelfCall(ctx, req, res, this.taskKind)) {
      return;
    }
    const parsed = this.parseRequest(parsedBody, ctx);
    if (!parsed.ok) {
      sendJson(res, 400, { error: parsed.error });
      return;
    }
    const intent = this.modelIntent(parsed.value, ctx);
    try {
      previewModelRequestTarget(ctx, intent);
    } catch (error) {
      if (!(error instanceof ModelRequestTargetError)) throw error;
      this.onOperationFailed(parsed.value, error.message);
      sendJson(res, 400, { error: error.message });
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
        queueLength: ctx.modelRequestQueue.length,
        elapsedMs: Date.now() - lockWaitStartedAt,
      });
    }, readLockWaitEmitIntervalMs());
    lockWaitTimer.unref();
    let modelRequestLock: ModelRequestLock | null;
    try {
      modelRequestLock = await acquireModelRequestWithWait(ctx, this.lockKind, req, res, {
        ownerRunId: this.lockOwnerRunId(parsed.value),
        intent,
      });
    } catch (error) {
      // Admission readies the model before granting; an unusable target or failed load lands here.
      clearInterval(lockWaitTimer);
      const status = error instanceof ModelRequestTargetError ? 400 : 503;
      const payload = recordServerError(req, status, error, { taskKind: this.taskKind });
      this.onOperationFailed(parsed.value, payload.error);
      terminalFrameSent = true;
      writer.writeEvent(OPERATION_STREAM_EVENTS.error, payload);
      writer.end();
      return;
    }
    clearInterval(lockWaitTimer);
    if (!modelRequestLock) {
      const message = MODEL_QUEUE_TIMEOUT_MESSAGE;
      const payload = recordServerError(req, 503, new Error(message), { taskKind: this.taskKind });
      this.onOperationFailed(parsed.value, payload.error);
      terminalFrameSent = true;
      writer.writeEvent(OPERATION_STREAM_EVENTS.error, {
        ...payload,
        modelRequests: getModelRequestQueueDiagnostics(ctx),
      });
      writer.end();
      return;
    }

    try {
      const result = await this.execute(
        ctx,
        parsed.value,
        new StreamedOperationContext(writer, abortController.signal, modelRequestLock.context),
      );
      terminalFrameSent = true;
      writer.writeEvent(OPERATION_STREAM_EVENTS.result, result);
    } catch (error) {
      const payload = recordServerError(req, 500, error, { taskKind: this.taskKind });
      this.onOperationFailed(parsed.value, payload.error);
      terminalFrameSent = true;
      writer.writeEvent(OPERATION_STREAM_EVENTS.error, payload);
    } finally {
      releaseModelRequest(ctx, modelRequestLock.token);
      writer.end();
    }
  }
}

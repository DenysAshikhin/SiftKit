import type { IncomingMessage, ServerResponse } from 'node:http';
import type { JsonSerializable } from '../lib/json-types.js';
import { OPERATION_STREAM_HEARTBEAT_MS } from '../lib/operation-stream.js';

const SSE_DRAIN_TIMEOUT_MS = 15_000;
const SSE_CHUNK_CODE_UNITS = 16 * 1024;
const SSE_MAX_BUFFERED_BYTES = 1024 * 1024;

/** Owns SSE headers, framing, heartbeats, and disconnect-safe writes. */
export class SseResponseWriter {
  private clientDisconnected = false;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private readonly heartbeatMs: number;
  private drainingFrame = false;
  private readonly drainTimeoutMs: number;

  constructor(
    req: IncomingMessage,
    private readonly res: ServerResponse,
    options: { heartbeatMs?: number; drainTimeoutMs?: number } = {},
  ) {
    this.heartbeatMs = options.heartbeatMs ?? OPERATION_STREAM_HEARTBEAT_MS;
    this.clientDisconnected = res.destroyed || res.writableEnded;
    this.drainTimeoutMs = options.drainTimeoutMs ?? SSE_DRAIN_TIMEOUT_MS;
    res.on('close', () => { this.clientDisconnected = true; this.stopHeartbeat(); });
    req.on('close', () => {
      if (!res.writableEnded) {
        this.clientDisconnected = true;
        this.stopHeartbeat();
      }
    });
  }

  open(): void {
    if (this.clientDisconnected) return;
    this.res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    this.res.write('\n');
    this.heartbeatTimer = setInterval(() => { if (!this.drainingFrame) this.writeRaw(': hb\n\n'); }, this.heartbeatMs);
    this.heartbeatTimer.unref();
  }

  writeEvent(eventName: string, payload: JsonSerializable): void {
    this.writeSerializedEvent(eventName, JSON.stringify(payload));
  }

  /** Frames a payload that is already JSON text, so a replayed frame is not re-encoded. */
  writeSerializedEvent(eventName: string, data: string): void {
    if (this.drainingFrame) throw new Error('Cannot interleave SSE events with a draining frame.');
    this.writeRaw(`event: ${eventName}\ndata: ${data}\n\n`);
  }

  /** A snapshot can exceed a socket's buffer. Send it in order, keeping at most one chunk queued. */
  async writeSerializedEventAndDrain(eventName: string, data: string): Promise<boolean> {
    if (this.drainingFrame) throw new Error('An SSE frame is already draining.');
    this.drainingFrame = true;
    try {
      for (const part of [`event: ${eventName}\ndata: `, data, '\n\n']) {
        for (let start = 0; start < part.length;) {
          if (this.clientDisconnected || this.res.writableEnded) return false;
          let end = Math.min(start + SSE_CHUNK_CODE_UNITS, part.length);
          const last = part.charCodeAt(end - 1);
          if (end < part.length && last >= 0xd800 && last <= 0xdbff) end--;
          const ready = this.res.write(part.slice(start, end));
          start = end;
          if (!ready && !await this.waitForDrain()) return false;
        }
      }
      return true;
    } catch {
      this.disconnect();
      return false;
    } finally {
      this.drainingFrame = false;
    }
  }

  private waitForDrain(): Promise<boolean> {
    if (this.res.destroyed || this.res.writableEnded) return Promise.resolve(false);
    return new Promise(resolve => {
      const cleanup = (): void => {
        clearTimeout(timer);
        this.res.off('drain', drained);
        this.res.off('close', closed);
        this.res.off('error', closed);
      };
      const drained = (): void => { cleanup(); resolve(true); };
      const closed = (): void => { cleanup(); resolve(false); };
      const timer = setTimeout(() => { this.disconnect(); closed(); }, this.drainTimeoutMs);
      timer.unref();
      this.res.once('drain', drained);
      this.res.once('close', closed);
      this.res.once('error', closed);
    });
  }

  private disconnect(): void {
    this.clientDisconnected = true;
    this.stopHeartbeat();
    this.res.destroy();
  }

  isClientDisconnected(): boolean {
    return this.clientDisconnected;
  }

  end(): void {
    this.stopHeartbeat();
    if (this.clientDisconnected || this.res.writableEnded) {
      return;
    }
    try {
      this.res.end();
    } catch {
      this.clientDisconnected = true;
    }
  }

  private writeRaw(text: string): void {
    if (this.clientDisconnected || this.res.writableEnded) {
      return;
    }
    try {
      if (this.res.writableLength + Buffer.byteLength(text) > SSE_MAX_BUFFERED_BYTES) {
        this.disconnect();
        return;
      }
      this.res.write(text);
    } catch {
      this.clientDisconnected = true;
      this.stopHeartbeat();
    }
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }
}

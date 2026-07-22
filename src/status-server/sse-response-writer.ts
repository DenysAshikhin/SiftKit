import type { IncomingMessage, ServerResponse } from 'node:http';
import type { JsonSerializable } from '../lib/json-types.js';
import { OPERATION_STREAM_HEARTBEAT_MS } from '../lib/operation-stream.js';

/** Owns SSE headers, framing, heartbeats, and disconnect-safe writes. */
export class SseResponseWriter {
  private clientDisconnected = false;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private readonly heartbeatMs: number;

  constructor(
    req: IncomingMessage,
    private readonly res: ServerResponse,
    options: { heartbeatMs?: number } = {},
  ) {
    this.heartbeatMs = options.heartbeatMs ?? OPERATION_STREAM_HEARTBEAT_MS;
    req.on('close', () => {
      if (!res.writableEnded) {
        this.clientDisconnected = true;
        this.stopHeartbeat();
      }
    });
  }

  open(): void {
    this.res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    this.res.write('\n');
    this.heartbeatTimer = setInterval(() => this.writeRaw(': hb\n\n'), this.heartbeatMs);
    this.heartbeatTimer.unref();
  }

  writeEvent(eventName: string, payload: JsonSerializable): void {
    this.writeRaw(`event: ${eventName}\ndata: ${JSON.stringify(payload)}\n\n`);
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
